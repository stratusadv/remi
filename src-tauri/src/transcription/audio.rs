use crate::contract::BarCount;
use crate::error::{AppError, AppResult};
use crate::workspace::{
    self,
    AUDIO_HOURS_MAX,
    AUDIO_SECONDS_MAX,
    PCM16_SAMPLE_BYTES,
    wav_reader_open,
};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, Indexing, PolynomialDegree, Resampler};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use symphonia::core::audio::{AudioSpec, GenericAudioBufferRef};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::common::Limit;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

const DECODE_ERROR_COUNT_MAX: u32 = 64;
const PACKET_COUNT_MAX: u32 = 4_000_000;
const RESAMPLE_CHUNK_SIZE: u32 = 16384;
const RESAMPLE_FLUSH_COUNT_MAX: u32 = 16;
pub(crate) const SAMPLE_RATE_WHISPER: u32 = 16000;
const SEEK_INDEX_FILL_PERIOD_MS: u16 = 1000;
const STREAM_BUFFER_BYTES: u32 = 64 * 1024;
const WAVEFORM_BAR_COUNT_MAX: u32 = 2000;
const WAVEFORM_READ_BLOCK_BYTES: u32 = 65536;

const _: () = assert!(WAVEFORM_READ_BLOCK_BYTES.is_multiple_of(PCM16_SAMPLE_BYTES));
const _: () = assert!(WAVEFORM_BAR_COUNT_MAX > 0);
const _: () = assert!(DECODE_ERROR_COUNT_MAX < PACKET_COUNT_MAX);
const _: () = assert!(RESAMPLE_FLUSH_COUNT_MAX > 0);

type SampleSink<'sink> = dyn FnMut(&[f32]) -> AppResult<()> + 'sink;

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Waveform {
    pub(crate) peaks: Vec<f32>,
    pub(crate) duration_seconds: f64,
}

struct DecodeTrack {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
}

struct DecodeFlow {
    decode_error_count: u32,
    interleaved: Vec<f32>,
    mono: Vec<f32>,
    progress: DecodeProgress,
    resampling: Option<Resampling>,
}

struct DecodeProgress {
    sample_count: u64,
    sample_rate: u32,
    channels: u16,
}

struct RateChange {
    source: u32,
    target: u32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct PreparePaths<'path> {
    pub(crate) prepared: &'path Path,
    pub(crate) source: &'path Path,
}

struct Resampling {
    delay_frames: u32,
    frames_emitted: u64,
    frames_received: u64,
    held: Vec<f32>,
    input: Vec<f32>,
    output: Vec<f32>,
    rates: RateChange,
    resampler: Async<f32>,
}

impl DecodeFlow {
    const fn new() -> Self {
        Self {
            decode_error_count: 0,
            interleaved: Vec::new(),
            mono: Vec::new(),
            progress: DecodeProgress { sample_count: 0, sample_rate: 0, channels: 0 },
            resampling: None,
        }
    }

    fn buffer_accept(
        &mut self,
        buffer: &GenericAudioBufferRef<'_>,
        sink: &mut SampleSink<'_>,
    ) -> AppResult<()> {
        let (channels, sample_rate) = decode_format_of(buffer.spec())?;

        self.format_settle(channels, sample_rate)?;

        buffer.copy_to_vec_interleaved(&mut self.interleaved);

        let samples_decoded = u64::try_from(self.interleaved.len()).unwrap_or(u64::MAX);
        self.progress.sample_count = self.progress.sample_count.saturating_add(samples_decoded);

        decode_samples_bound_check(&self.progress)?;

        self.mono.clear();
        mix_to_mono(&self.interleaved, channels, &mut self.mono);

        assert_eq!(self.mono.len(), self.interleaved.len().div_euclid(usize::from(channels)));
        assert_eq!(self.progress.channels, channels);

        match self.resampling.as_mut() {
            Some(resampling) => resampling.push(&self.mono, sink),
            None => sink(&self.mono),
        }
    }

    fn decode_error_note(&mut self) -> AppResult<()> {
        assert!(self.decode_error_count <= DECODE_ERROR_COUNT_MAX);

        self.decode_error_count += 1;

        decode_error_count_check(self.decode_error_count)
    }

    fn finish(self, sink: &mut SampleSink<'_>) -> AppResult<()> {
        assert!(self.decode_error_count <= DECODE_ERROR_COUNT_MAX);

        if self.progress.sample_rate == 0 {
            return Err(AppError::Audio("no audio decoded from track".into()));
        }

        assert!(self.progress.channels > 0);

        if self.decode_error_count > 0 {
            tracing::warn!(
                target: "remi_lib::transcription",
                "{} packets could not be decoded and were skipped",
                self.decode_error_count,
            );
        }

        self.resampling.map_or_else(|| Ok(()), |mut resampling| resampling.finish(sink))
    }

    fn format_settle(&mut self, channels: u16, sample_rate: u32) -> AppResult<()> {
        assert!(channels > 0);
        assert!(sample_rate > 0);

        if self.progress.sample_rate == 0 {
            self.resampling = Resampling::for_rate(sample_rate)?;
            self.progress.channels = channels;
            self.progress.sample_rate = sample_rate;

            return Ok(());
        }

        let unchanged =
            self.progress.channels == channels && self.progress.sample_rate == sample_rate;

        if !unchanged {
            return Err(AppError::Audio(
                "the recording changes its channels or sample rate partway through, which the \
                 app does not read"
                    .into(),
            ));
        }

        Ok(())
    }
}

impl Resampling {
    fn chunk_process(&mut self, indexing: &Indexing, sink: &mut SampleSink<'_>) -> AppResult<()> {
        let frames_input = self.input.len();
        let frames_output = self.output.len();

        let buffer_in = InterleavedSlice::new(self.input.as_slice(), 1, frames_input)
            .map_err(|error| AppError::Audio(format!("resampler input: {error}")))?;

        let mut buffer_out =
            InterleavedSlice::new_mut(self.output.as_mut_slice(), 1, frames_output)
                .map_err(|error| AppError::Audio(format!("resampler output: {error}")))?;

        let (_consumed, produced) = self
            .resampler
            .process_into_buffer(&buffer_in, &mut buffer_out, Some(indexing))
            .map_err(|error| AppError::Audio(format!("resample: {error}")))?;

        let trimmed = produced.min(usize_of!(self.delay_frames));

        let fresh = self
            .output
            .get(trimmed..produced)
            .ok_or_else(|| AppError::Audio("the resampler wrote past its output".into()))?;

        sink(&self.held)?;

        let emitted = u64::try_from(self.held.len()).unwrap_or(u64::MAX);
        self.delay_frames = self.delay_frames.saturating_sub(u32::try_from(trimmed).unwrap_or(0));
        self.frames_emitted = self.frames_emitted.saturating_add(emitted);

        self.held.clear();
        self.held.extend_from_slice(fresh);

        assert!(self.held.len() <= frames_output);
        assert!(produced <= frames_output);

        Ok(())
    }

    fn finish(&mut self, sink: &mut SampleSink<'_>) -> AppResult<()> {
        let expected = resample_output_length(self.frames_received, &self.rates);

        if !self.input.is_empty() {
            let partial = Indexing { partial_len: Some(self.input.len()), ..Indexing::default() };

            self.chunk_process(&partial, sink)?;
            self.input.clear();
        }

        let flush = Indexing { partial_len: Some(0), ..Indexing::default() };

        for _flush_index in 0..RESAMPLE_FLUSH_COUNT_MAX {
            if self.frames_produced() >= expected {
                break;
            }

            self.chunk_process(&flush, sink)?;
        }

        let complete = self.frames_produced() >= expected && self.frames_emitted <= expected;

        if !complete {
            return Err(AppError::Audio("the resampler did not reach the end of the audio".into()));
        }

        let remaining = usize::try_from(expected - self.frames_emitted).unwrap_or(usize::MAX);
        let tail_length = remaining.min(self.held.len());

        sink(self.held.get(..tail_length).unwrap_or_default())?;

        assert_eq!(self.frames_emitted + u64::try_from(tail_length).unwrap_or(0), expected);
        assert!(tail_length <= self.held.len());

        Ok(())
    }

    fn for_rate(sample_rate: u32) -> AppResult<Option<Self>> {
        assert!(sample_rate > 0);

        if sample_rate == SAMPLE_RATE_WHISPER {
            return Ok(None);
        }

        let rates = RateChange { source: sample_rate, target: SAMPLE_RATE_WHISPER };
        let ratio = f64::from(rates.target) / f64::from(rates.source);
        let chunk = usize_of!(RESAMPLE_CHUNK_SIZE);

        let resampler = Async::<f32>::new_poly(
            ratio,
            1.0,
            PolynomialDegree::Cubic,
            chunk,
            1,
            FixedAsync::Input,
        )
        .map_err(|error| AppError::Audio(format!("resampler init: {error}")))?;

        let output = vec![0.0_f32; resampler.output_frames_max()];

        assert_eq!(resampler.input_frames_next(), chunk);
        assert_ne!(output.len(), 0);

        Ok(Some(Self {
            delay_frames: u32::try_from(resampler.output_delay()).unwrap_or(u32::MAX),
            frames_emitted: 0,
            frames_received: 0,
            held: Vec::with_capacity(output.len()),
            input: Vec::with_capacity(chunk.saturating_mul(2)),
            output,
            rates,
            resampler,
        }))
    }

    fn frames_produced(&self) -> u64 {
        let held = u64::try_from(self.held.len()).unwrap_or(u64::MAX);

        self.frames_emitted.saturating_add(held)
    }

    fn push(&mut self, mono: &[f32], sink: &mut SampleSink<'_>) -> AppResult<()> {
        let chunk = usize_of!(RESAMPLE_CHUNK_SIZE);
        let received = u64::try_from(mono.len()).unwrap_or(u64::MAX);

        self.input.extend_from_slice(mono);
        self.frames_received = self.frames_received.saturating_add(received);

        let chunk_count = self.input.len().saturating_sub(1).div_euclid(chunk);

        for chunk_index in 0..chunk_count {
            let indexing = Indexing { input_offset: chunk_index * chunk, ..Indexing::default() };

            self.chunk_process(&indexing, sink)?;
        }

        drop(self.input.drain(..chunk_count * chunk));

        assert!(self.input.len() <= chunk);
        assert!(!self.input.is_empty() || self.frames_received == 0);

        Ok(())
    }
}

#[cfg(test)]
pub(crate) fn load_for_whisper(path: &Path) -> AppResult<Vec<f32>> {
    let mut track = decode_track_open(path)?;
    let mut samples: Vec<f32> = Vec::new();

    decode_packets(&mut track, &mut |block| {
        samples.extend_from_slice(block);

        Ok(())
    })?;

    assert!(samples.iter().all(|sample| sample.is_finite()));

    Ok(samples)
}

pub(crate) fn prepare_for_whisper(paths: &PreparePaths<'_>) -> AppResult<()> {
    assert_ne!(paths.prepared, paths.source);

    let mut track = decode_track_open(paths.source)?;

    workspace::audio_wav_save_streamed(paths.prepared, SAMPLE_RATE_WHISPER, |writer| {
        decode_packets(&mut track, &mut |block| workspace::pcm16_append(writer, block))
    })?;

    assert!(paths.prepared.is_file());

    Ok(())
}

pub(crate) fn waveform_compute(audio_path: &Path, bar_count: BarCount) -> AppResult<Waveform> {
    let BarCount(bars_wanted) = bar_count;
    let bars = bars_wanted.min(WAVEFORM_BAR_COUNT_MAX);
    let reader = wav_reader_open(audio_path)?;
    let specification = reader.spec();
    let frame_count = reader.duration();

    assert!(specification.sample_rate > 0);

    let duration_seconds = f64::from(frame_count) / f64::from(specification.sample_rate);

    assert!(duration_seconds >= 0.0_f64);

    if bars == 0 {
        return Ok(Waveform { peaks: Vec::new(), duration_seconds });
    }

    if frame_count == 0 {
        return Ok(Waveform { peaks: Vec::new(), duration_seconds });
    }

    if specification.bits_per_sample != 16 {
        return Err(AppError::Audio(format!(
            "waveform expects 16-bit PCM, got {}-bit samples",
            specification.bits_per_sample,
        )));
    }

    if specification.sample_format != hound::SampleFormat::Int {
        return Err(AppError::Audio(format!(
            "waveform expects integer PCM, got {:?} samples",
            specification.sample_format,
        )));
    }

    let samples_total = u64::from(frame_count) * u64::from(specification.channels);
    let mut data = reader.into_inner();
    let peaks = waveform_peaks_scan(&mut data, samples_total, bars)?;

    assert!(u32::try_from(peaks.len()).is_ok_and(|count| count <= bars));
    assert!(peaks.iter().all(|peak| peak.is_finite()));

    Ok(Waveform { peaks, duration_seconds })
}

fn decode_error_count_check(decode_error_count: u32) -> AppResult<()> {
    assert!(decode_error_count > 0);

    if decode_error_count > DECODE_ERROR_COUNT_MAX {
        return Err(AppError::Audio(format!(
            "more than {DECODE_ERROR_COUNT_MAX} parts of this recording could not be decoded; \
             the file is damaged or in a format the app does not read",
        )));
    }

    Ok(())
}

fn decode_format_of(specification: &AudioSpec) -> AppResult<(u16, u32)> {
    let channels = u16::try_from(specification.channels().count()).map_err(|_overflow| {
        AppError::Audio("track reports more channels than fit in u16".into())
    })?;

    let sample_rate = specification.rate();
    let usable = channels > 0 && sample_rate > 0;

    if !usable {
        return Err(AppError::Audio("no audio decoded from track".into()));
    }

    Ok((channels, sample_rate))
}

fn decode_packets(track: &mut DecodeTrack, sink: &mut SampleSink<'_>) -> AppResult<()> {
    let DecodeTrack { format, decoder, track_id } = track;
    let mut flow = DecodeFlow::new();

    for _packet_index in 0..PACKET_COUNT_MAX {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => return flow.finish(sink),
            Err(error) => return Err(AppError::Audio(format!("packet read: {error}"))),
        };

        if packet.track_id != *track_id {
            continue;
        }

        match decoder.decode(&packet) {
            Ok(buffer) => flow.buffer_accept(&buffer, sink)?,
            Err(symphonia::core::errors::Error::DecodeError(_)) => flow.decode_error_note()?,
            Err(error) => return Err(AppError::Audio(format!("decode: {error}"))),
        }
    }

    Err(AppError::Audio(format!(
        "this recording holds more than the {PACKET_COUNT_MAX} packets the app decodes in one pass",
    )))
}

fn decode_samples_bound_check(progress: &DecodeProgress) -> AppResult<()> {
    assert!(progress.sample_rate > 0);
    assert!(progress.channels > 0);

    let samples_max =
        AUDIO_SECONDS_MAX * u64::from(progress.sample_rate) * u64::from(progress.channels);

    if progress.sample_count > samples_max {
        return Err(AppError::Audio(format!(
            "this recording is longer than the {AUDIO_HOURS_MAX} hours this app transcribes",
        )));
    }

    Ok(())
}

fn decode_track_open(path: &Path) -> AppResult<DecodeTrack> {
    let file = File::open(path)?;
    let stream_options = MediaSourceStreamOptions { buffer_len: usize_of!(STREAM_BUFFER_BYTES) };
    let stream = MediaSourceStream::new(Box::new(file), stream_options);
    let mut hint = Hint::new();

    if let Some(extension) = path.extension().and_then(|suffix| suffix.to_str()) {
        let _hint = hint.with_extension(extension);
    }

    let format_options = FormatOptions::default()
        .prebuild_seek_index(false)
        .seek_index_fill_period_ms(SEEK_INDEX_FILL_PERIOD_MS);

    let metadata_options = MetadataOptions::default()
        .limit_tag_bytes(Limit::Default)
        .limit_visual_bytes(Limit::Default);

    let format = symphonia::default::get_probe()
        .probe(&hint, stream, format_options, metadata_options)
        .map_err(|error| AppError::Audio(format!("probe: {error}")))?;

    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| AppError::Audio("no audio track found".into()))?;

    let codec_parameters = track
        .codec_params
        .as_ref()
        .and_then(|parameters| parameters.audio())
        .ok_or_else(|| AppError::Audio("the audio track carries no codec parameters".into()))?;

    let track_id = track.id;

    let decoder = symphonia::default::get_codecs()
        .make_audio_decoder(codec_parameters, &AudioDecoderOptions::default())
        .map_err(|error| AppError::Audio(format!("decoder init: {error}")))?;

    Ok(DecodeTrack { format, decoder, track_id })
}

fn mix_to_mono(interleaved: &[f32], channels: u16, mono: &mut Vec<f32>) {
    assert!(channels > 0);

    let mono_length_before = mono.len();
    let channel_count = usize::from(channels);

    if channels == 1 {
        mono.extend_from_slice(interleaved);
    } else {
        let frames = interleaved.chunks_exact(channel_count);

        mono.extend(frames.map(|frame| frame.iter().sum::<f32>() / f32::from(channels)));
    }

    assert_eq!(mono.len() - mono_length_before, interleaved.len().div_euclid(channel_count));
}

fn resample_output_length(input_length: u64, rates: &RateChange) -> u64 {
    assert!(input_length < u64::MAX);
    assert!(rates.source > 0);
    assert!(rates.target > 0);

    let scaled = input_length.saturating_mul(u64::from(rates.target));
    let output_length = scaled.div_ceil(u64::from(rates.source));

    assert!(output_length <= scaled);

    output_length
}

fn waveform_peaks_normalize(peaks: &mut [f32]) {
    let peak_max = peaks.iter().copied().fold(0.0_f32, f32::max);

    assert!(peak_max >= 0.0);

    if peak_max <= 0.0 {
        return;
    }

    for peak in peaks.iter_mut() {
        *peak /= peak_max;
    }

    assert!(peaks.iter().copied().fold(0.0_f32, f32::max) <= 1.0);
}

fn waveform_peaks_scan<Data: Read + Seek>(
    data: &mut Data,
    samples_total: u64,
    bar_count: u32,
) -> AppResult<Vec<f32>> {
    assert!(samples_total > 0);
    assert!(bar_count > 0);

    let bucket_size = samples_total.div_ceil(u64::from(bar_count));
    let sample_bytes = u64::from(PCM16_SAMPLE_BYTES);
    let block_bytes = usize_of!(WAVEFORM_READ_BLOCK_BYTES);
    let mut peaks: Vec<f32> = Vec::with_capacity(usize::try_from(bar_count).unwrap_or(0));
    let mut block = vec![0_u8; block_bytes];
    let mut bucket_start: u64 = 0;

    let data_start =
        data.stream_position().map_err(|error| AppError::Audio(format!("wav seek: {error}")))?;

    assert!(bucket_size > 0);

    while bucket_start < samples_total {
        let bucket_samples = (samples_total - bucket_start).min(bucket_size);

        let read_bytes_wanted = usize::try_from(bucket_samples.saturating_mul(sample_bytes))
            .unwrap_or(block_bytes)
            .min(block_bytes);

        assert!(read_bytes_wanted.is_multiple_of(usize_of!(PCM16_SAMPLE_BYTES)));

        let block_wanted = block
            .get_mut(..read_bytes_wanted)
            .ok_or_else(|| AppError::Audio("waveform read block overflow".into()))?;

        let _position = data
            .seek(SeekFrom::Start(data_start + bucket_start * sample_bytes))
            .map_err(|error| AppError::Audio(format!("wav seek: {error}")))?;

        data.read_exact(block_wanted)
            .map_err(|error| AppError::Audio(format!("wav read: {error}")))?;

        let (pairs, _) = block_wanted.as_chunks::<{ size_of::<i16>() }>();

        let bucket_peak =
            pairs.iter().map(|pair| i16::from_le_bytes(*pair).unsigned_abs()).max().unwrap_or(0);

        peaks.push(f32::from(bucket_peak) / f32::from(i16::MAX));
        bucket_start += bucket_size;
    }

    waveform_peaks_normalize(&mut peaks);

    assert!(u32::try_from(peaks.len()).is_ok_and(|count| count <= bar_count));

    Ok(peaks)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::test_support::root_scoped;
    use crate::workspace::{audio_wav_save, root, samples_to_pcm16};
    use std::fs;
    use std::io::Cursor;
    use std::num::NonZeroU32;
    use symphonia::core::audio::Channels;

    const PACKET_FRAMES: [u32; 3] = [1024, 1152, 4097];
    const RATES_DELAYLESS: [u32; 2] = [44_100, 48_000];
    const RATES_SWEPT: [u32; 11] =
        [8000, 11_025, 12_000, 22_050, 24_000, 32_000, 44_100, 48_000, 88_200, 96_000, 192_000];

    fn block_collect(collected: &mut Vec<f32>, block: &[f32]) {
        let collected_length_before = collected.len();

        collected.extend_from_slice(block);

        assert_eq!(collected.len(), collected_length_before + block.len());
    }

    fn block_count(counted: &mut u64, block: &[f32]) {
        let block_length = u64::try_from(block.len()).unwrap();

        *counted += block_length;

        assert!(*counted >= block_length);
    }

    fn frame_lengths() -> [u32; 7] {
        let chunk = RESAMPLE_CHUNK_SIZE;

        [0, 1, chunk - 1, chunk, chunk + 1, chunk * 3 + 17, 100_003]
    }

    fn mono_of(interleaved: &[f32], channels: u16) -> Vec<f32> {
        assert!(channels > 0);

        let mut mono = Vec::new();

        mix_to_mono(interleaved, channels, &mut mono);

        mono
    }

    fn resample(input: &[f32], rates: &RateChange) -> AppResult<Vec<f32>> {
        let packet_frames = u32::try_from(input.len()).ok().and_then(NonZeroU32::new);

        resample_in_packets(input, rates.source, packet_frames.unwrap_or(NonZeroU32::MIN))
    }

    fn resample_in_packets(
        input: &[f32],
        rate: u32,
        packet_frames: NonZeroU32,
    ) -> AppResult<Vec<f32>> {
        assert!(rate > 0);
        assert!(input.len() <= usize_of!(RESAMPLE_CHUNK_SIZE * 64));

        let mut resampling = Resampling::for_rate(rate)?.unwrap();
        let mut output: Vec<f32> = Vec::new();

        for packet in input.chunks(usize_of!(packet_frames.get())) {
            resampling.push(packet, &mut |block| {
                block_collect(&mut output, block);

                Ok(())
            })?;

            assert!(resampling.input.len() <= usize_of!(RESAMPLE_CHUNK_SIZE));
            assert!(resampling.held.len() <= resampling.output.len());
        }

        resampling.finish(&mut |block| {
            block_collect(&mut output, block);

            Ok(())
        })?;

        Ok(output)
    }

    fn resample_reference(input: &[f32], rate: u32) -> Vec<f32> {
        assert!(rate > 0);

        let ratio = f64::from(SAMPLE_RATE_WHISPER) / f64::from(rate);
        let chunk = usize_of!(RESAMPLE_CHUNK_SIZE);

        let mut resampler = Async::<f32>::new_poly(
            ratio,
            1.0,
            PolynomialDegree::Cubic,
            chunk,
            1,
            FixedAsync::Input,
        )
        .unwrap();

        let buffer_in = InterleavedSlice::new(input, 1, input.len()).unwrap();

        resampler.process_all(&buffer_in, input.len(), None).unwrap().take_data()
    }

    fn signal_of(length: u32, rate: NonZeroU32) -> Vec<f32> {
        assert!(length <= RESAMPLE_CHUNK_SIZE * 64);
        assert!(rate.get() >= 8000);

        (0..length)
            .map(|index| {
                let seconds = f64::from(index) / f64::from(rate.get());
                let tone = (seconds * 440.0_f64 * std::f64::consts::TAU).sin() * 0.5_f64;

                num_traits::cast::<f64, f32>(tone).unwrap()
            })
            .collect()
    }

    #[test]
    fn a_waveform_has_one_peak_per_bucket_and_none_for_empty_audio_or_zero_bars() {
        let _root = root_scoped();
        let path = root().unwrap().join("audio.wav");
        let samples = [0.0_f32, 0.25, 0.5, 0.25, 1.0, 0.0];

        audio_wav_save(&samples, 16000, &path).unwrap();

        let waveform = waveform_compute(&path, BarCount(3)).unwrap();

        assert_eq!(waveform.peaks.len(), 3);
        assert!((waveform.peaks[0] - 0.25).abs() < 1e-4);
        assert!((waveform.peaks[1] - 0.5).abs() < 1e-4);
        assert!((waveform.peaks[2] - 1.0).abs() < 1e-6);
        assert!((waveform.duration_seconds - 6.0 / 16000.0).abs() < 1e-9_f64);
        assert_eq!(waveform_compute(&path, BarCount(0)).unwrap().peaks.len(), 0);

        let capped = waveform_compute(&path, BarCount(u32::MAX)).unwrap();

        assert_eq!(capped.peaks.len(), samples.len());

        audio_wav_save(&[], 16000, &path).unwrap();

        assert_eq!(waveform_compute(&path, BarCount(3)).unwrap().peaks.len(), 0);

        assert!(
            waveform_compute(&path, BarCount(3)).unwrap().duration_seconds.abs() < f64::EPSILON
        );
    }

    #[test]
    fn a_waveform_needs_16_bit_integer_samples() {
        let _root = root_scoped();
        let path = root().unwrap().join("audio.wav");

        let specification = hound::WavSpec {
            channels: 1,
            sample_rate: 8000,
            bits_per_sample: 8,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&path, specification).unwrap();

        writer.write_sample(1_i8).unwrap();
        writer.finalize().unwrap();

        assert_ne!(waveform_compute(&path, BarCount(1)).unwrap_err().to_string(), "");
    }

    #[test]
    fn a_partial_last_bucket_still_yields_a_peak() {
        let samples: Vec<u8> =
            [0x1000_i16, 0x2000, 0x0800].iter().flat_map(|sample| sample.to_le_bytes()).collect();

        let peaks = waveform_peaks_scan(&mut Cursor::new(samples.as_slice()), 3, 2).expect("scan");

        assert_eq!(peaks.len(), 2);
        assert!((peaks[0] - 1.0).abs() < 1e-6);
        assert!((peaks[1] - 0.25).abs() < 1e-6);
    }

    #[test]
    fn stereo_frames_with_a_dangling_sample_drop_it() {
        assert_eq!(mono_of(&[1.0, 1.0, 1.0], 2), vec![1.0]);
        assert_eq!(mono_of(&[], 2).len(), 0);
        assert_eq!(mono_of(&[], 1).len(), 0);
    }

    #[test]
    fn resampling_halves_the_length_and_keeps_a_steady_signal_level() {
        let input = vec![0.5_f32; 32000];
        let output = resample(&input, &RateChange { source: 32000, target: 16000 }).unwrap();

        assert!(output.len().abs_diff(16000) <= 1);
        assert!(output.iter().all(|sample| sample.is_finite()));
        assert!((output[8000] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn a_wav_loads_for_whisper_at_its_native_rate_or_resampled_to_it() {
        let _root = root_scoped();
        let native = root().unwrap().join("native.wav");
        let slow = root().unwrap().join("slow.wav");
        let samples = vec![0.25_f32; 8000];

        audio_wav_save(&samples, SAMPLE_RATE_WHISPER, &native).unwrap();
        audio_wav_save(&samples, 8000, &slow).unwrap();

        let loaded_native = load_for_whisper(&native).unwrap();
        let loaded_slow = load_for_whisper(&slow).unwrap();

        assert_eq!(loaded_native.len(), samples.len());
        assert!((loaded_native[100] - 0.25).abs() < 1e-3);
        assert!(loaded_slow.len().abs_diff(16000) <= 1);
        assert!((loaded_slow[8000] - 0.25).abs() < 1e-2);

        fs::write(&native, b"not audio").unwrap();

        assert_ne!(load_for_whisper(&native).unwrap_err().to_string(), "");

        assert_ne!(
            load_for_whisper(&root().unwrap().join("missing.wav")).unwrap_err().to_string(),
            "",
        );
    }

    #[test]
    fn a_stereo_file_is_mixed_down_before_it_is_returned() {
        let _root = root_scoped();
        let path = root().unwrap().join("stereo.wav");

        let specification = hound::WavSpec {
            channels: 2,
            sample_rate: SAMPLE_RATE_WHISPER,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&path, specification).unwrap();

        for _frame in 0_i32..100_i32 {
            writer.write_sample(i16::MAX).unwrap();
            writer.write_sample(0_i16).unwrap();
        }

        writer.finalize().unwrap();

        let mono = load_for_whisper(&path).unwrap();

        assert_eq!(mono.len(), 100);
        assert!((mono[50] - 0.5).abs() < 1e-3);
    }

    #[test]
    fn peaks_are_normalised_against_the_loudest_bucket() {
        let mut peaks = vec![0.25_f32, 0.5, 0.125];

        waveform_peaks_normalize(&mut peaks);

        assert_eq!(peaks, vec![0.5, 1.0, 0.25]);
    }

    #[test]
    fn silence_is_left_alone_rather_than_divided_by_zero() {
        let mut peaks = vec![0.0_f32, 0.0];

        waveform_peaks_normalize(&mut peaks);

        assert_eq!(peaks, vec![0.0, 0.0]);
    }

    #[test]
    fn one_bar_per_sample_gives_one_peak_per_sample() {
        let samples: Vec<u8> = vec![0x00, 0x40, 0x00, 0x20];
        let peaks = waveform_peaks_scan(&mut Cursor::new(samples.as_slice()), 2, 2).expect("scan");

        assert_eq!(peaks.len(), 2);
        assert_eq!(peaks, vec![1.0, 0.5]);
    }

    #[test]
    fn a_decode_that_runs_past_the_audio_limit_is_refused() {
        let within = AUDIO_SECONDS_MAX * 16000;

        let at_limit = DecodeProgress { sample_count: within, sample_rate: 16000, channels: 1 };
        let past_limit = DecodeProgress { sample_count: within + 1, ..at_limit };
        let stereo = DecodeProgress { sample_count: within * 2, channels: 2, ..at_limit };

        decode_samples_bound_check(&at_limit).unwrap();
        decode_samples_bound_check(&stereo).unwrap();

        assert!(decode_samples_bound_check(&past_limit).is_err());
    }

    #[test]
    fn a_decode_holds_one_chunk_of_audio_however_long_the_recording_is() {
        let packets = vec![0.25_f32; 1152];
        let mut resampling = Resampling::for_rate(48_000).unwrap().unwrap();
        let mut emitted: u64 = 0;
        let capacity_input = resampling.input.capacity();
        let capacity_held = resampling.held.capacity();

        for _packet_index in 0..2000_u32 {
            resampling
                .push(&packets, &mut |block| {
                    block_count(&mut emitted, block);

                    Ok(())
                })
                .unwrap();
        }

        assert_eq!(resampling.input.capacity(), capacity_input);
        assert_eq!(resampling.held.capacity(), capacity_held);

        resampling
            .finish(&mut |block| {
                block_count(&mut emitted, block);

                Ok(())
            })
            .unwrap();

        assert_eq!(emitted, (2000 * 1152_u64).div_euclid(3));
    }

    #[test]
    fn a_track_reporting_no_channels_or_rate_is_refused_rather_than_decoded() {
        let silent = AudioSpec::new(0, Channels::Discrete(1));
        let empty = AudioSpec::new(16000, Channels::Discrete(0));
        let mono = AudioSpec::new(16000, Channels::Discrete(1));

        assert_ne!(decode_format_of(&silent).unwrap_err().to_string(), "");
        assert_ne!(decode_format_of(&empty).unwrap_err().to_string(), "");
        assert_eq!(decode_format_of(&mono).unwrap(), (1, 16000));
    }

    #[test]
    fn a_mostly_undecodable_file_is_refused_rather_than_read_as_silence() {
        decode_error_count_check(1).unwrap();
        decode_error_count_check(DECODE_ERROR_COUNT_MAX).unwrap();
        assert!(decode_error_count_check(DECODE_ERROR_COUNT_MAX + 1).is_err());
    }

    #[test]
    fn stereo_frames_are_averaged_into_one_channel() {
        assert_eq!(mono_of(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(mono_of(&[0.25, 0.75], 1), vec![0.25, 0.75]);
    }

    #[test]
    fn streamed_resampling_matches_the_whole_clip_resampled_at_once() {
        for rate in RATES_DELAYLESS {
            for length in frame_lengths() {
                let input = signal_of(length, NonZeroU32::new(rate).unwrap());
                let reference = resample_reference(&input, rate);

                for packet_frames in PACKET_FRAMES {
                    let packet = NonZeroU32::new(packet_frames).unwrap();
                    let streamed = resample_in_packets(&input, rate, packet).unwrap();

                    assert_eq!(streamed.len(), reference.len());
                    assert!(
                        streamed
                            .iter()
                            .zip(&reference)
                            .all(|(left, right)| left.to_bits() == right.to_bits())
                    );
                }
            }
        }
    }

    #[test]
    fn streamed_resampling_keeps_the_rate_ratio_length_at_every_source_rate() {
        for rate in RATES_SWEPT {
            let rates = RateChange { source: rate, target: SAMPLE_RATE_WHISPER };

            for length in frame_lengths() {
                let input = vec![0.5_f32; usize_of!(length)];
                let packet = NonZeroU32::new(1152).unwrap();
                let streamed = resample_in_packets(&input, rate, packet).unwrap();
                let wanted = resample_output_length(u64::from(length), &rates);

                assert_eq!(u64::try_from(streamed.len()).unwrap(), wanted);
                assert!(streamed.iter().all(|sample| sample.is_finite()));

                if streamed.len() > 64 {
                    assert!((streamed[streamed.len().div_euclid(2)] - 0.5).abs() < 1e-3);
                }
            }
        }
    }

    #[test]
    fn a_prepared_file_holds_the_mixed_and_resampled_pcm16_of_its_source() {
        let _root = root_scoped();
        let source = root().unwrap().join("stereo.wav");
        let target = root().unwrap().join("prepared.wav");
        let frames = frame_lengths()[6];
        let left = signal_of(frames, NonZeroU32::new(48_000).unwrap());

        let specification = hound::WavSpec {
            channels: 2,
            sample_rate: 48_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut writer = hound::WavWriter::create(&source, specification).unwrap();

        for value in samples_to_pcm16(&left) {
            writer.write_sample(value).unwrap();
            writer.write_sample(0_i16).unwrap();
        }

        writer.finalize().unwrap();
        prepare_for_whisper(&PreparePaths { prepared: &target, source: &source }).unwrap();

        let mut reader = hound::WavReader::open(&source).unwrap();
        let decoded: Vec<f32> =
            reader.samples::<i16>().map(|sample| f32::from(sample.unwrap()) / 32768.0).collect();
        let mono: Vec<f32> = decoded
            .as_chunks::<2>()
            .0
            .iter()
            .map(|frame| frame.iter().sum::<f32>() / 2.0)
            .collect();
        let wanted: Vec<i16> = samples_to_pcm16(&resample_reference(&mono, 48_000)).collect();
        let prepared = hound::WavReader::open(&target).unwrap();

        assert_eq!(prepared.spec().sample_rate, SAMPLE_RATE_WHISPER);
        assert_eq!(prepared.spec().channels, 1);

        let written: Vec<i16> = prepared.into_samples::<i16>().map(Result::unwrap).collect();

        assert_eq!(written.len(), wanted.len());
        assert_eq!(written, wanted);
    }

    #[test]
    fn a_source_that_fails_to_decode_leaves_no_prepared_file_behind() {
        let _root = root_scoped();
        let source = root().unwrap().join("broken.wav");
        let target = root().unwrap().join("prepared.wav");

        fs::write(&source, b"RIFF but not really audio").unwrap();

        let paths = PreparePaths { prepared: &target, source: &source };

        assert_ne!(prepare_for_whisper(&paths).unwrap_err().to_string(), "");
        assert!(!target.exists());

        let leftovers = fs::read_dir(root().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with("tmp"));

        assert_eq!(leftovers.count(), 0);
    }

    #[test]
    fn the_resampled_length_follows_the_rate_ratio() {
        assert_eq!(
            resample_output_length(48000, &RateChange { source: 48000, target: 16000 }),
            16000,
        );

        assert_eq!(resample_output_length(100, &RateChange { source: 16000, target: 16000 }), 100);
        assert_eq!(resample_output_length(1, &RateChange { source: 44100, target: 16000 }), 1);
        assert_eq!(resample_output_length(0, &RateChange { source: 44100, target: 16000 }), 0);
    }
}
