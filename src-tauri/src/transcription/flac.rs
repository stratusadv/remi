const BITS_PER_SAMPLE: u32 = 16;
const BLOCK_FRAMES: u16 = 4096;
const CRC16_POLYNOMIAL: u16 = 0x8005;
const CRC8_POLYNOMIAL: u8 = 0x07;
const FRAME_FORMAT: u8 = 0b0000_1000;
const FRAME_INDEX_MAX: u32 = 0xFFFF;
const FRAME_SIZES: u8 = 0b0111_0000;
const FRAME_MARKER: [u8; 2] = [0xFF, 0xF8];
const ORDER_MAX: u8 = 4;
const PARTITION_ORDER_FULL: u32 = 4;
const RESIDUAL_MAGNITUDE_MAX: u32 = 1 << 19;
const RICE_PARAMETER_MAX: u32 = 14;
pub(super) const SAMPLE_RATE_MAX: u32 = (1 << 20) - 1;
const STREAM_MARKER: &[u8; 4] = b"fLaC";
const STREAMINFO_BYTES: u32 = 34;
const STREAMINFO_LAST: u8 = 0x80;
const SUBFRAME_FIXED: u8 = 0b0001_0000;
const SUBFRAME_VERBATIM: u8 = 0b0000_0010;
const UNARY_RUN_BITS: u32 = 32;

const _: () = assert!(ORDER_MAX == 4);
const _: () = assert!((BLOCK_FRAMES >> PARTITION_ORDER_FULL).ilog2() > ORDER_MAX.ilog2());
const _: () = assert!(RICE_PARAMETER_MAX < 15);

#[derive(Clone, Copy)]
struct Bits {
    count: u32,
    value: u32,
}

struct BitWriter {
    bytes: Vec<u8>,
    pending: u64,
    pending_bits: u32,
}

impl BitWriter {
    fn align(&mut self) {
        let padding = (8 - self.pending_bits.rem_euclid(8)).rem_euclid(8);

        assert!(padding < 8);

        self.bits_write(Bits { count: padding, value: 0 });

        assert_eq!(self.pending_bits, 0);
    }

    fn bits_write(&mut self, bits: Bits) {
        assert!(bits.count <= UNARY_RUN_BITS);
        assert_eq!(u64::from(bits.value) >> bits.count, 0);

        self.pending = (self.pending << bits.count) | u64::from(bits.value);
        self.pending_bits += bits.count;

        while self.pending_bits >= 8 {
            self.pending_bits -= 8;

            let [byte, ..] = (self.pending >> self.pending_bits).to_le_bytes();

            self.bytes.push(byte);
        }

        assert!(self.pending_bits < 8);
    }

    fn rice_write(&mut self, residual: i32, parameter: u32) {
        assert!(residual.unsigned_abs() <= RESIDUAL_MAGNITUDE_MAX);
        assert!(parameter <= RICE_PARAMETER_MAX);

        let folded = zigzag(residual);
        let quotient = folded >> parameter;

        for _run in 0..quotient.div_euclid(UNARY_RUN_BITS) {
            self.bits_write(Bits { count: UNARY_RUN_BITS, value: 0 });
        }

        self.bits_write(Bits { count: quotient.rem_euclid(UNARY_RUN_BITS) + 1, value: 1 });
        self.bits_write(Bits { count: parameter, value: folded & ((1 << parameter) - 1) });
    }
}

pub(crate) fn flac_encode(samples: &[i16], sample_rate: u32) -> Vec<u8> {
    assert!(sample_rate > 0);
    assert!(sample_rate <= SAMPLE_RATE_MAX);

    let mut writer =
        BitWriter { bytes: Vec::with_capacity(samples.len()), pending: 0, pending_bits: 0 };

    stream_header_write(&mut writer, u64::try_from(samples.len()).unwrap_or(0), sample_rate);

    for (frame_index, block) in (0_u32..).zip(samples.chunks(usize::from(BLOCK_FRAMES))) {
        frame_write(&mut writer, block, frame_index);
    }

    assert!(writer.bytes.starts_with(STREAM_MARKER));
    assert_eq!(writer.pending_bits, 0);

    writer.bytes
}

fn crc16_of(bytes: &[u8]) -> u16 {
    bytes.iter().fold(0, |crc, byte| {
        (0_i32..8_i32).fold(crc ^ (u16::from(*byte) << 8_i32), |value, _bit| {
            let shifted = value << 1_i32;

            if value & 0x8000 == 0 { shifted } else { shifted ^ CRC16_POLYNOMIAL }
        })
    })
}

fn crc8_of(bytes: &[u8]) -> u8 {
    bytes.iter().fold(0, |crc, byte| {
        (0_i32..8_i32).fold(crc ^ byte, |value, _bit| {
            let shifted = value << 1_i32;

            if value & 0x80 == 0 { shifted } else { shifted ^ CRC8_POLYNOMIAL }
        })
    })
}

fn frame_number_write(bytes: &mut Vec<u8>, frame_index: u32) {
    assert!(frame_index <= FRAME_INDEX_MAX);

    if frame_index < 0x80 {
        let [whole, ..] = frame_index.to_le_bytes();

        bytes.push(whole);

        return;
    }

    let [low, ..] = (frame_index & 0x3F).to_le_bytes();
    let [middle, ..] = ((frame_index >> 6) & 0x3F).to_le_bytes();

    if frame_index < 0x800 {
        bytes.extend_from_slice(&[0xC0 | middle, 0x80 | low]);

        return;
    }

    let [high, ..] = (frame_index >> 12).to_le_bytes();

    bytes.extend_from_slice(&[0xE0 | high, 0x80 | middle, 0x80 | low]);
}

fn frame_write(writer: &mut BitWriter, block: &[i16], frame_index: u32) {
    assert_ne!(block.len(), 0);
    assert!(block.len() <= usize::from(BLOCK_FRAMES));
    assert!(frame_index <= FRAME_INDEX_MAX);

    let frame_start = writer.bytes.len();
    let frames_less_one = u16::try_from(block.len() - 1).unwrap_or(BLOCK_FRAMES - 1);

    writer.bytes.extend_from_slice(&FRAME_MARKER);
    writer.bytes.extend_from_slice(&[FRAME_SIZES, FRAME_FORMAT]);
    frame_number_write(&mut writer.bytes, frame_index);
    writer.bytes.extend_from_slice(&frames_less_one.to_be_bytes());

    let header = writer.bytes.get(frame_start..).unwrap_or_default();
    let header_crc = crc8_of(header);

    writer.bytes.push(header_crc);
    subframe_write(writer, block);
    writer.align();

    let frame = writer.bytes.get(frame_start..).unwrap_or_default();
    let frame_crc = crc16_of(frame);

    writer.bytes.extend_from_slice(&frame_crc.to_be_bytes());

    assert_eq!(writer.pending_bits, 0);
    assert!(writer.bytes.len() > frame_start);
}

fn partition_bits(partition: &[i32], parameter: u32) -> u64 {
    assert!(parameter <= RICE_PARAMETER_MAX);

    let length = u64::try_from(partition.len()).unwrap_or(0);
    let quotients: u64 = partition.iter().map(|value| u64::from(zigzag(*value) >> parameter)).sum();
    let bits = quotients + (u64::from(parameter) + 1) * length;

    assert!(bits >= length);

    bits
}

fn partitions_of(residuals: &[i32], order: u8, block_frames: u16) -> Vec<&[i32]> {
    assert!(order <= ORDER_MAX);
    assert!(block_frames <= BLOCK_FRAMES);

    let partition_frames = usize::from(block_frames >> partition_order_of(block_frames));
    let frames_first = partition_frames - usize::from(order);
    let (first, rest) = residuals.split_at(frames_first);
    let partitions: Vec<&[i32]> =
        std::iter::once(first).chain(rest.chunks(partition_frames)).collect();

    assert_eq!(partitions.iter().map(|part| part.len()).sum::<usize>(), residuals.len());
    assert_ne!(partitions.len(), 0);

    partitions
}

const fn partition_order_of(block_frames: u16) -> u32 {
    assert!(block_frames <= BLOCK_FRAMES);

    if block_frames == BLOCK_FRAMES { PARTITION_ORDER_FULL } else { 0 }
}

fn residuals_best(block: &[i16]) -> (u8, Vec<i32>) {
    assert_ne!(block.len(), 0);

    let order_max = u8::try_from(block.len() - 1).map_or(ORDER_MAX, |top| top.min(ORDER_MAX));
    let mut current: Vec<i32> = block.iter().map(|sample| i32::from(*sample)).collect();
    let mut best = current.clone();
    let mut best_order: u8 = 0;

    for order in 1..=order_max {
        current = current
            .windows(2)
            .map(|pair| match pair {
                [earlier, later] => later - earlier,
                _ => 0_i32,
            })
            .collect();

        if residuals_weight(&current) < residuals_weight(&best) {
            best.clone_from(&current);
            best_order = order;
        }
    }

    assert_eq!(best.len() + usize::from(best_order), block.len());
    assert!(best_order <= ORDER_MAX);

    (best_order, best)
}

fn residuals_weight(residuals: &[i32]) -> u64 {
    residuals.iter().map(|value| u64::from(value.unsigned_abs())).sum()
}

fn rice_parameter_of(partition: &[i32]) -> u32 {
    assert!(partition.len() <= usize::from(BLOCK_FRAMES));

    let sum: u64 = partition.iter().map(|value| u64::from(zigzag(*value))).sum();
    let mean = sum.div_euclid(u64::try_from(partition.len().max(1)).unwrap_or(1));
    let estimate = mean.bit_width().min(RICE_PARAMETER_MAX);

    let parameter = (estimate.saturating_sub(2)..=estimate)
        .min_by_key(|candidate| partition_bits(partition, *candidate))
        .unwrap_or(estimate);

    assert!(parameter <= RICE_PARAMETER_MAX);

    parameter
}

fn stream_header_write(writer: &mut BitWriter, frame_count: u64, sample_rate: u32) {
    assert_eq!(frame_count >> 36_i32, 0);
    assert!(sample_rate <= SAMPLE_RATE_MAX);

    writer.bytes.extend_from_slice(STREAM_MARKER);
    writer.bytes.push(STREAMINFO_LAST);
    writer.bits_write(Bits { count: 24, value: STREAMINFO_BYTES });
    writer.bits_write(Bits { count: 16, value: u32::from(BLOCK_FRAMES) });
    writer.bits_write(Bits { count: 16, value: u32::from(BLOCK_FRAMES) });
    writer.bits_write(Bits { count: 24, value: 0 });
    writer.bits_write(Bits { count: 24, value: 0 });
    writer.bits_write(Bits { count: 20, value: sample_rate });
    writer.bits_write(Bits { count: 3, value: 0 });
    writer.bits_write(Bits { count: 5, value: BITS_PER_SAMPLE - 1 });
    writer.bits_write(Bits { count: 4, value: u32::try_from(frame_count >> 32_i32).unwrap_or(0) });

    writer.bits_write(Bits {
        count: 32,
        value: u32::try_from(frame_count & u64::from(u32::MAX)).unwrap_or(0),
    });

    writer.bytes.extend_from_slice(&[0; 16]);

    assert_eq!(writer.pending_bits, 0);
}

fn subframe_write(writer: &mut BitWriter, block: &[i16]) {
    assert_ne!(block.len(), 0);
    assert!(block.len() <= usize::from(BLOCK_FRAMES));

    let (order, residuals) = residuals_best(block);
    let block_frames = u16::try_from(block.len()).unwrap_or(BLOCK_FRAMES);
    let partitions = partitions_of(&residuals, order, block_frames);
    let parameters: Vec<u32> = partitions.iter().map(|part| rice_parameter_of(part)).collect();

    let rice_bits: u64 = partitions
        .iter()
        .zip(&parameters)
        .map(|(partition, parameter)| partition_bits(partition, *parameter))
        .sum();

    if rice_bits >= u64::try_from(block.len()).unwrap_or(0) * u64::from(BITS_PER_SAMPLE) {
        writer.bytes.push(SUBFRAME_VERBATIM);

        for sample in block {
            writer.bytes.extend_from_slice(&sample.to_be_bytes());
        }

        return;
    }

    writer.bytes.push(SUBFRAME_FIXED | (order << 1_i32));

    for sample in block.iter().take(usize::from(order)) {
        writer.bytes.extend_from_slice(&sample.to_be_bytes());
    }

    writer.bits_write(Bits { count: 2, value: 0 });
    writer.bits_write(Bits { count: 4, value: partition_order_of(block_frames) });

    for (partition, parameter) in partitions.iter().zip(parameters) {
        writer.bits_write(Bits { count: 4, value: parameter });

        for residual in *partition {
            writer.rice_write(*residual, parameter);
        }
    }
}

const fn zigzag(value: i32) -> u32 {
    assert!(value.unsigned_abs() <= RESIDUAL_MAGNITUDE_MAX);

    ((value << 1) ^ (value >> 31)).cast_unsigned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use std::num::NonZeroU32;
    use symphonia::core::codecs::audio::AudioDecoderOptions;
    use symphonia::core::common::Limit;
    use symphonia::core::formats::probe::Hint;
    use symphonia::core::formats::{FormatOptions, TrackType};
    use symphonia::core::io::{MediaSourceStream, MediaSourceStreamOptions};
    use symphonia::core::meta::MetadataOptions;

    const PACKETS_MAX: u32 = 1 << 16;
    const SAMPLE_RATE: u32 = 16_000;

    fn decoded(bytes: Vec<u8>) -> (Vec<i16>, u32) {
        assert!(bytes.starts_with(STREAM_MARKER));

        let source = MediaSourceStream::new(
            Box::new(Cursor::new(bytes)),
            MediaSourceStreamOptions { buffer_len: 64 * 1024 },
        );

        let mut hint = Hint::new();
        let _hint = hint.with_extension("flac");
        let format_options = FormatOptions::default().prebuild_seek_index(false);
        let metadata_options = MetadataOptions::default().limit_tag_bytes(Limit::Default);

        let mut format = symphonia::default::get_probe()
            .probe(&hint, source, format_options, metadata_options)
            .unwrap();

        let track = format.default_track(TrackType::Audio).unwrap();
        let parameters = track.codec_params.as_ref().and_then(|codec| codec.audio()).unwrap();
        let rate = parameters.sample_rate.unwrap();

        let mut decoder = symphonia::default::get_codecs()
            .make_audio_decoder(parameters, &AudioDecoderOptions::default())
            .unwrap();

        let mut samples: Vec<i16> = Vec::new();
        let mut packet_samples: Vec<i16> = Vec::new();

        for _packet in 0..PACKETS_MAX {
            let Some(packet) = format.next_packet().unwrap() else {
                return (samples, rate);
            };

            decoder.decode(&packet).unwrap().copy_to_vec_interleaved(&mut packet_samples);
            samples.extend_from_slice(&packet_samples);
        }

        panic!("the stream holds more than {PACKETS_MAX} packets");
    }

    fn round_trips(samples: &[i16]) {
        let (read, rate) = decoded(flac_encode(samples, SAMPLE_RATE));

        assert_eq!(rate, SAMPLE_RATE);
        assert_eq!(read.len(), samples.len());
        assert!(read == samples, "the decoded samples differ from the {} encoded", samples.len());
    }

    fn noise(count: u32, seed: NonZeroU32) -> Vec<i16> {
        assert!(count > 0);

        let mut state = seed.get();
        let mut samples: Vec<i16> = Vec::new();

        for _index in 0..count {
            state ^= state << 13_i32;
            state ^= state >> 17_i32;
            state ^= state << 5_i32;

            let [low, high, ..] = state.to_le_bytes();

            samples.push(i16::from_le_bytes([low, high]));
        }

        samples
    }

    fn seed_of(value: u32) -> NonZeroU32 {
        assert_ne!(value, 0);

        NonZeroU32::new(value).unwrap()
    }

    fn voice_like(count: u32) -> Vec<i16> {
        assert!(count > 0);

        let hiss = noise(count, seed_of(0x1234_5678));

        (0_i32..)
            .zip(hiss)
            .map(|(index, grain)| {
                let pitch = (index.rem_euclid(160) - 80).abs();
                let envelope = (index.rem_euclid(8_000) - 4_000).abs().div_euclid(16);

                i16::try_from(pitch * envelope + i32::from(grain >> 8_i32)).unwrap()
            })
            .collect()
    }

    #[test]
    fn each_length_around_a_block_boundary_round_trips_through_a_real_decoder() {
        for count in
            [1, 2, 3, 4, 5, 6, 15, 16, 17, 255, 256, 257, 4_095, 4_096, 4_097, 8_192, 9_000]
        {
            round_trips(&voice_like(count));
        }
    }

    #[test]
    fn extreme_signals_round_trip_through_a_real_decoder() {
        round_trips(&vec![0; 10_000]);
        round_trips(&vec![i16::MAX; 5_000]);
        round_trips(&vec![i16::MIN; 5_000]);
        round_trips(&noise(20_000, seed_of(0x9E37_79B9)));

        let square: Vec<i16> = (0_i32..10_000_i32)
            .map(|index| if index % 2_i32 == 0_i32 { i16::MAX } else { i16::MIN })
            .collect();

        assert_eq!(square.len(), 10_000);

        round_trips(&square);
    }

    #[test]
    fn a_long_stream_keeps_its_frame_numbers_through_a_real_decoder() {
        let samples = voice_like(4_096 * 200 + 123);

        assert_eq!(samples.len(), 4_096 * 200 + 123);

        round_trips(&samples);
    }

    #[test]
    fn a_voice_signal_takes_well_under_the_bytes_of_raw_pcm() {
        let samples = voice_like(16_000 * 30);
        let raw_bytes = samples.len() * 2;
        let encoded_bytes = flac_encode(&samples, SAMPLE_RATE).len();

        assert!(encoded_bytes * 10 < raw_bytes * 7, "{encoded_bytes} of {raw_bytes}");
    }

    #[test]
    fn white_noise_grows_by_no_more_than_its_frame_headers() {
        let samples = noise(4_096 * 10, seed_of(0xDEAD_BEEF));
        let raw_bytes = samples.len() * 2;
        let encoded_bytes = flac_encode(&samples, SAMPLE_RATE).len();

        assert!(encoded_bytes < raw_bytes + 100 + 10 * 12, "{encoded_bytes} of {raw_bytes}");
    }

    #[test]
    fn the_checksums_match_their_published_check_values() {
        assert_eq!(crc8_of(b"123456789"), 0xF4);
        assert_eq!(crc16_of(b"123456789"), 0xFEE8);
    }

    #[test]
    fn zigzag_folds_small_magnitudes_to_small_values() {
        assert_eq!(zigzag(0), 0);
        assert_eq!(zigzag(-1), 1);
        assert_eq!(zigzag(1), 2);
        assert_eq!(zigzag(-2), 3);
    }
}
