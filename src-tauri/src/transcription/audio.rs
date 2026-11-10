use crate::contract::BarCount;
use crate::error::{AppError, AppResult};
use crate::workspace::{AUDIO_HOURS_MAX, AUDIO_SECONDS_MAX, PCM16_SAMPLE_BYTES, wav_reader_open};
use rubato::audioadapter_buffers::direct::InterleavedSlice;
use rubato::{Async, FixedAsync, PolynomialDegree, Resampler};
use serde::Serialize;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use symphonia::core::audio::{AudioSpec, Channels};
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::common::Limit;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader, TrackType};
use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
use symphonia::core::meta::MetadataOptions;

const DECODE_ERROR_COUNT_MAX: u32 = 64;
const DECODE_SAMPLES_MAX: u64 = AUDIO_SECONDS_MAX * 48_000 * 2;
const PACKET_COUNT_MAX: u32 = 4_000_000;
const RESAMPLE_CHUNK_SIZE: u32 = 16384;
pub(crate) const SAMPLE_RATE_WHISPER: u32 = 16000;
const SEEK_INDEX_FILL_PERIOD_MS: u16 = 1000;
const STREAM_BUFFER_BYTES: u32 = 64 * 1024;
const WAVEFORM_BAR_COUNT_MAX: u32 = 2000;
const WAVEFORM_READ_BLOCK_BYTES: u32 = 65536;

const _: () = assert!(WAVEFORM_READ_BLOCK_BYTES.is_multiple_of(PCM16_SAMPLE_BYTES));
const _: () = assert!(WAVEFORM_BAR_COUNT_MAX > 0);
const _: () = assert!(DECODE_ERROR_COUNT_MAX < PACKET_COUNT_MAX);

#[derive(Debug, Clone, Serialize)]
pub(crate) struct Waveform {
    pub(crate) peaks: Vec<f32>,
    pub(crate) duration_seconds: f64,
}

struct DecodeTrack {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track_id: u32,
    samples_capacity_hint: u64,
}

struct DecodedAudio {
    samples: Vec<f32>,
    sample_rate: u32,
    channels: u16,
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

pub(crate) fn load_for_whisper(path: &Path) -> AppResult<Vec<f32>> {
    let decoded = decode_packets(&mut decode_track_open(path)?)?;
    let mono = mix_to_mono(&decoded.samples, decoded.channels);

    assert!(decoded.sample_rate > 0);
    assert!(mono.len() <= decoded.samples.len());

    if decoded.sample_rate == SAMPLE_RATE_WHISPER {
        return Ok(mono);
    }

    resample(&mono, &RateChange { source: decoded.sample_rate, target: SAMPLE_RATE_WHISPER })
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

fn decode_packets(track: &mut DecodeTrack) -> AppResult<DecodedAudio> {
    let DecodeTrack { format, decoder, track_id, samples_capacity_hint } = track;
    let capacity = usize::try_from(*samples_capacity_hint).unwrap_or(0);
    let mut samples: Vec<f32> = Vec::new();
    let mut packet_samples: Vec<f32> = Vec::new();
    let mut channels: u16 = 0;
    let mut sample_rate: u32 = 0;
    let mut decode_error_count: u32 = 0;

    if let Err(error) = samples.try_reserve_exact(capacity) {
        tracing::warn!(
            target: "scribe_lib::transcription",
            "the track declares more samples than can be set aside: {error}",
        );
    }

    for _packet_index in 0..PACKET_COUNT_MAX {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => {
                let decoded = DecodedAudio { samples, sample_rate, channels };

                return decode_packets_finish(decoded, decode_error_count);
            }
            Err(error) => return Err(AppError::Audio(format!("packet read: {error}"))),
        };

        if packet.track_id != *track_id {
            continue;
        }

        let audio_buffer = match decoder.decode(&packet) {
            Ok(audio_buffer) => audio_buffer,
            Err(symphonia::core::errors::Error::DecodeError(_)) => {
                decode_error_count += 1;

                decode_error_count_check(decode_error_count)?;

                continue;
            }
            Err(error) => return Err(AppError::Audio(format!("decode: {error}"))),
        };

        if channels == 0 {
            (channels, sample_rate) = decode_format_of(audio_buffer.spec())?;
        }

        audio_buffer.copy_to_vec_interleaved(&mut packet_samples);

        samples.try_reserve(packet_samples.len()).map_err(|error| {
            AppError::Audio(format!("there is not enough memory to decode this file: {error}"))
        })?;

        samples.extend_from_slice(&packet_samples);

        decode_samples_bound_check(&DecodeProgress {
            sample_count: u64::try_from(samples.len()).unwrap_or(u64::MAX),
            sample_rate,
            channels,
        })?;
    }

    Err(AppError::Audio(format!(
        "this recording holds more than the {PACKET_COUNT_MAX} packets the app decodes in one pass",
    )))
}

fn decode_packets_finish(
    decoded: DecodedAudio,
    decode_error_count: u32,
) -> AppResult<DecodedAudio> {
    assert!(decoded.samples.is_empty() || decoded.channels > 0);
    assert!(decode_error_count <= DECODE_ERROR_COUNT_MAX);

    if decoded.channels == 0 {
        return Err(AppError::Audio("no audio decoded from track".into()));
    }

    if decoded.sample_rate == 0 {
        return Err(AppError::Audio("no audio decoded from track".into()));
    }

    if decode_error_count > 0 {
        tracing::warn!(
            target: "scribe_lib::transcription",
            "{decode_error_count} packets could not be decoded and were skipped",
        );
    }

    assert!(decoded.sample_rate > 0);
    assert!(decoded.channels > 0);

    Ok(decoded)
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

    if progress.sample_count > DECODE_SAMPLES_MAX {
        return Err(AppError::Audio(format!(
            "this recording decodes to more than the {DECODE_SAMPLES_MAX} samples this app holds",
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
    let frame_count_hint = track.num_frames;
    let channels_hint = codec_parameters.channels.as_ref().map(Channels::count);

    let decoder = symphonia::default::get_codecs()
        .make_audio_decoder(codec_parameters, &AudioDecoderOptions::default())
        .map_err(|error| AppError::Audio(format!("decoder init: {error}")))?;

    let samples_capacity_hint = match (frame_count_hint, channels_hint) {
        (Some(frames), Some(channel_count)) => {
            frames.saturating_mul(u64::try_from(channel_count).unwrap_or(0))
        }
        _ => 0,
    };

    Ok(DecodeTrack { format, decoder, track_id, samples_capacity_hint })
}

fn mix_to_mono(interleaved: &[f32], channels: u16) -> Vec<f32> {
    assert!(channels > 0);

    if channels == 1 {
        return interleaved.to_vec();
    }

    let channel_count = usize::from(channels);

    let mono: Vec<f32> = interleaved
        .chunks_exact(channel_count)
        .map(|frame| frame.iter().sum::<f32>() / f32::from(channels))
        .collect();

    assert_eq!(mono.len(), interleaved.len().div_euclid(channel_count));

    mono
}

fn resample(input: &[f32], rates: &RateChange) -> AppResult<Vec<f32>> {
    assert!(rates.source > 0);
    assert!(rates.target > 0);
    assert_ne!(rates.source, rates.target);

    let ratio = f64::from(rates.target) / f64::from(rates.source);

    let mut resampler = Async::<f32>::new_poly(
        ratio,
        1.0,
        PolynomialDegree::Cubic,
        usize_of!(RESAMPLE_CHUNK_SIZE),
        1,
        FixedAsync::Input,
    )
    .map_err(|error| AppError::Audio(format!("resampler init: {error}")))?;

    let buffer_in = InterleavedSlice::new(input, 1, input.len())
        .map_err(|error| AppError::Audio(format!("resampler input: {error}")))?;

    let output = resampler
        .process_all(&buffer_in, input.len(), None)
        .map_err(|error| AppError::Audio(format!("resample: {error}")))?
        .take_data();

    let input_length = u64::try_from(input.len()).unwrap_or(0);
    let output_length = resample_output_length(input_length, rates);

    assert!(u64::try_from(output.len()).unwrap_or(0).abs_diff(output_length) <= 1);

    Ok(output)
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
    use crate::workspace::{audio_wav_save, root};
    use std::fs;
    use std::io::Cursor;

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
        assert_eq!(mix_to_mono(&[1.0, 1.0, 1.0], 2), vec![1.0]);
        assert_eq!(mix_to_mono(&[], 2).len(), 0);
        assert_eq!(mix_to_mono(&[], 1).len(), 0);
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
    fn a_decode_that_fits_the_hours_but_not_the_memory_is_refused() {
        let channels_many = DecodeProgress {
            sample_count: DECODE_SAMPLES_MAX + 1,
            sample_rate: 48_000,
            channels: 8,
        };

        let stereo_longest =
            DecodeProgress { sample_count: DECODE_SAMPLES_MAX, sample_rate: 48_000, channels: 2 };

        decode_samples_bound_check(&stereo_longest).unwrap();

        assert!(decode_samples_bound_check(&channels_many).is_err());
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
        assert_eq!(mix_to_mono(&[1.0, 0.0, 0.5, 0.5], 2), vec![0.5, 0.5]);
        assert_eq!(mix_to_mono(&[0.25, 0.75], 1), vec![0.25, 0.75]);
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
