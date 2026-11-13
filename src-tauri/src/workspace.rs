use crate::contract::{ClipEnd, ClipStart};
use crate::error::{AppError, AppResult};
use num_traits::ToPrimitive;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufReader, BufWriter, Read};
use std::path::{Path, PathBuf};
use std::thread;

const AUDIO_FILE_NAME: &str = "audio.wav";
pub(crate) const AUDIO_HOURS_MAX: u64 = 6;
pub(crate) const AUDIO_SECONDS_MAX: u64 = AUDIO_HOURS_MAX * 60 * 60;
const CLIP_FILE_PREFIX: &str = "clip-";
const ENGINE_COUNT_MAX: u32 = 16;
#[cfg(not(windows))]
const FILE_MODE_PRIVATE: u32 = 0o600;
const HASH_BUFFER_BYTES: u32 = 64 * 1024;
pub(crate) const JOB_COUNT_MAX: u32 = 4096;
const JOB_ID_BYTES: usize = 16;
const JOB_ID_HEX_LENGTH: usize = JOB_ID_BYTES * 2;
const JOBS_FOLDER: &str = "jobs";
const META_BYTES_MAX: u32 = 64 << 10;
const META_FILE_NAME: &str = "meta.json";
pub(crate) const NOTES_BYTES_MAX: u32 = 4 << 20;
const NOTES_FILE_NAME: &str = "notes.md";
pub(crate) const PCM16_SAMPLE_BYTES: u32 = 2;
const TRANSCRIPT_BLANK_BYTES_MAX: u64 = 64;
const TRANSCRIPT_BYTES_MAX: u32 = 64 << 20;
const TRANSCRIPT_FILE_PREFIX: &str = "transcript-";
const TRANSCRIPT_FILE_SUFFIX: &str = ".json";

const _: () = assert!(META_BYTES_MAX < TRANSCRIPT_BYTES_MAX);
const _: () = assert!(NOTES_BYTES_MAX < TRANSCRIPT_BYTES_MAX);

pub(crate) type PcmWriter = hound::WavWriter<BufWriter<fs::File>>;

#[derive(Clone, Copy, Debug)]
pub(crate) struct ClipPaths<'path> {
    pub(crate) clip: &'path Path,
    pub(crate) source: &'path Path,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct ClipSpan {
    end_seconds: f64,
    start_seconds: f64,
}

#[derive(Debug)]
pub(crate) struct JobFiles {
    pub(crate) meta: String,
    pub(crate) notes: Option<String>,
    pub(crate) transcript: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct JobMeta {
    pub(crate) id: String,
    pub(crate) source_path: String,
    pub(crate) source_size_bytes: u64,
    pub(crate) created_at_unix: i64,
    #[serde(default)]
    pub(crate) recorded_at_unix: Option<i64>,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) attendees: Vec<String>,
    #[serde(default)]
    pub(crate) person_ids: Vec<String>,
    #[serde(default)]
    pub(crate) person_ids_mentioned: Vec<String>,
    #[serde(default)]
    pub(crate) project: Option<String>,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) favourite: bool,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct JobListing {
    #[serde(flatten)]
    pub(crate) meta: JobMeta,
    pub(crate) has_transcript: bool,
    pub(crate) has_notes: bool,
    pub(crate) duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct JobMetaPatch {
    #[serde(default)]
    pub(crate) title: Option<String>,
    #[serde(default)]
    pub(crate) attendees: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) person_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) person_ids_mentioned: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) project: Option<String>,
    #[serde(default)]
    pub(crate) tags: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) favourite: Option<bool>,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct TranscriptSlot<'text> {
    pub(crate) engine_id: &'text str,
    pub(crate) job_id: &'text str,
}

impl ClipSpan {
    pub(crate) fn of(start: ClipStart, end: ClipEnd) -> AppResult<Self> {
        let ClipStart(start_seconds) = start;
        let ClipEnd(end_seconds) = end;
        let ordered = start_seconds >= 0.0_f64 && end_seconds > start_seconds;

        if !ordered {
            return Err(AppError::Config("a clip needs a positive time range".into()));
        }

        Ok(Self { end_seconds, start_seconds })
    }
}

impl JobMetaPatch {
    #[cfg(test)]
    pub(crate) fn empty() -> Self {
        Self::default()
    }
}

pub(crate) fn atomic_write(path: &Path, contents: &[u8]) -> AppResult<()> {
    atomic_replace(path, |path_temporary| Ok(fs::write(path_temporary, contents)?))
}

#[cfg(not(windows))]
pub(crate) fn atomic_write_private(path: &Path, contents: &[u8]) -> AppResult<()> {
    use std::fs::{OpenOptions, Permissions};
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    assert!(path.file_name().is_some());

    atomic_replace(path, |path_temporary| {
        let mut file = OpenOptions::new()
            .create(true)
            .mode(FILE_MODE_PRIVATE)
            .truncate(true)
            .write(true)
            .open(path_temporary)?;

        file.set_permissions(Permissions::from_mode(FILE_MODE_PRIVATE))?;
        file.write_all(contents)?;

        Ok(())
    })
}

pub(crate) fn audio_clip_save(paths: &ClipPaths<'_>, span: ClipSpan) -> AppResult<()> {
    assert!(span.start_seconds >= 0.0_f64);
    assert!(span.end_seconds > span.start_seconds);

    let mut reader = wav_reader_open(paths.source)?;
    let specification = reader.spec();
    let rate = f64::from(specification.sample_rate);
    let length = reader.len();
    let sample_start = sample_index_clamp((span.start_seconds * rate).floor(), length);
    let sample_end = sample_index_clamp((span.end_seconds * rate).ceil(), length);

    if sample_end <= sample_start {
        return Err(AppError::Audio("the clip lies past the end of the audio".into()));
    }

    reader.seek(sample_start).map_err(|error| AppError::Audio(format!("wav seek: {error}")))?;

    let mut writer = hound::WavWriter::create(paths.clip, specification)
        .map_err(|error| AppError::Audio(format!("wav create: {error}")))?;

    let sample_count = usize::try_from(sample_end - sample_start).unwrap_or(usize::MAX);

    for sample in reader.samples::<i16>().take(sample_count) {
        let value = sample.map_err(|error| AppError::Audio(format!("wav read: {error}")))?;

        writer
            .write_sample(value)
            .map_err(|error| AppError::Audio(format!("wav write: {error}")))?;
    }

    writer.finalize().map_err(|error| AppError::Audio(format!("wav finalize: {error}")))?;

    Ok(())
}

pub(crate) fn audio_wav_duration_seconds(path: &Path) -> AppResult<f64> {
    let reader = wav_reader_open(path)?;
    let sample_rate = reader.spec().sample_rate;

    assert!(sample_rate > 0);

    let duration_seconds = f64::from(reader.duration()) / f64::from(sample_rate);

    assert!(duration_seconds >= 0.0_f64);
    assert!(duration_seconds.is_finite());

    Ok(duration_seconds)
}

pub(crate) fn audio_wav_is_prepared(path: &Path) -> bool {
    assert!(path.file_name().is_some());

    if !path.exists() {
        return false;
    }

    !audio_wav_duration_seconds(path).is_ok_and(|seconds| seconds <= 0.0_f64)
}

#[cfg(test)]
pub(crate) fn audio_wav_load(path: &Path) -> AppResult<(Vec<f32>, u32)> {
    let mut reader = wav_reader_open(path)?;
    let sample_rate = reader.spec().sample_rate;
    let samples_max = u64::from(reader.len());

    let read: Result<Vec<f32>, _> = reader
        .samples::<i16>()
        .map(|sample| sample.map(|value| f32::from(value) / f32::from(i16::MAX)))
        .collect();

    let samples = read.map_err(|error| AppError::Audio(format!("wav read: {error}")))?;

    assert!(sample_rate > 0);
    assert!(u64::try_from(samples.len()).unwrap_or(u64::MAX) <= samples_max);

    Ok((samples, sample_rate))
}

#[cfg(test)]
pub(crate) fn audio_wav_save(samples: &[f32], sample_rate: u32, path: &Path) -> AppResult<()> {
    assert!(sample_rate > 0);
    assert!(path.file_name().is_some());

    let sample_count = u64::try_from(samples.len()).unwrap_or(u64::MAX);

    audio_wav_save_streamed(path, sample_rate, |writer| {
        pcm16_append(writer, samples)?;

        assert_eq!(u64::from(writer.len()), sample_count);

        Ok(())
    })
}

pub(crate) fn audio_wav_save_streamed<Fill>(
    path: &Path,
    sample_rate: u32,
    fill: Fill,
) -> AppResult<()>
where
    Fill: FnOnce(&mut PcmWriter) -> AppResult<()>,
{
    assert!(sample_rate > 0);
    assert!(path.file_name().is_some());

    atomic_replace(path, |path_temporary| {
        let specification = wav_specification_mono_pcm16(sample_rate);

        let mut writer = hound::WavWriter::create(path_temporary, specification)
            .map_err(|error| AppError::Audio(format!("wav create: {error}")))?;

        fill(&mut writer)?;

        writer.finalize().map_err(|error| AppError::Audio(format!("wav finalize: {error}")))
    })
}

pub(crate) fn engines_for_job(id: &str) -> AppResult<Vec<String>> {
    job_id_validate(id)?;

    let directory = jobs_directory()?.join(id);

    if !directory.exists() {
        return Ok(Vec::new());
    }

    let mut engines: Vec<String> = Vec::new();

    for listed in fs::read_dir(directory)? {
        let entry = listed?;
        let name = entry.file_name();
        let name_text = name.to_string_lossy();

        let Some(rest) = name_text.strip_prefix(TRANSCRIPT_FILE_PREFIX) else {
            continue;
        };

        let Some(engine) = rest.strip_suffix(TRANSCRIPT_FILE_SUFFIX) else {
            continue;
        };

        if transcript_file_is_blank(&entry.path()) {
            continue;
        }

        if engines.len() >= usize_of!(ENGINE_COUNT_MAX) {
            return Err(AppError::Config(format!(
                "job {id} holds more than the {ENGINE_COUNT_MAX} transcripts this app keeps",
            )));
        }

        engines.push(engine.to_owned());
    }

    engines.sort();

    assert!(engines.len() <= usize_of!(ENGINE_COUNT_MAX));

    Ok(engines)
}

pub(crate) fn file_read_bounded(path: &Path, size_bytes_max: u32) -> AppResult<String> {
    assert!(size_bytes_max > 0);

    let size = fs::metadata(path)?.len();

    if size > u64::from(size_bytes_max) {
        return Err(file_oversized(path, size, size_bytes_max));
    }

    let contents = fs::read_to_string(path)?;

    if contents.len() > usize_of!(size_bytes_max) {
        let size_read = u64::try_from(contents.len()).unwrap_or(u64::MAX);

        return Err(file_oversized(path, size_read, size_bytes_max));
    }

    Ok(contents)
}

pub(crate) fn job_audio_clip_path(id: &str, span: ClipSpan) -> AppResult<PathBuf> {
    assert!(span.start_seconds >= 0.0_f64);
    assert!(span.end_seconds > span.start_seconds);

    let start_milliseconds = milliseconds_for(span.start_seconds);
    let end_milliseconds = milliseconds_for(span.end_seconds);
    let file_name = format!("{CLIP_FILE_PREFIX}{start_milliseconds}-{end_milliseconds}.wav");

    Ok(job_directory(id)?.join(file_name))
}

pub(crate) fn job_audio_clips_remove(id: &str) -> AppResult<()> {
    for entry in fs::read_dir(job_directory(id)?)? {
        let path = entry?.path();
        let name = path.file_name().map(|file_name| file_name.to_string_lossy().into_owned());

        if name.is_some_and(|file_name| file_name.starts_with(CLIP_FILE_PREFIX)) {
            fs::remove_file(&path)?;
        }
    }

    Ok(())
}

pub(crate) fn job_audio_path(id: &str) -> AppResult<PathBuf> {
    Ok(job_directory(id)?.join(AUDIO_FILE_NAME))
}

pub(crate) fn job_delete(id: &str) -> AppResult<()> {
    job_id_validate(id)?;

    let directory = jobs_directory()?.join(id);

    if directory.exists() {
        fs::remove_dir_all(&directory)?;
    }

    index_refresh(id);

    Ok(())
}

pub(crate) fn job_directory(id: &str) -> AppResult<PathBuf> {
    job_id_validate(id)?;

    let path = jobs_directory()?.join(id);

    fs::create_dir_all(&path)?;

    assert!(path.ends_with(id));

    Ok(path)
}

pub(crate) fn job_files_load(id: &str) -> AppResult<Option<JobFiles>> {
    job_id_validate(id)?;

    let directory = jobs_directory()?.join(id);
    let meta_path = directory.join(META_FILE_NAME);
    let notes_path = directory.join(NOTES_FILE_NAME);

    if !meta_path.is_file() {
        return Ok(None);
    }

    let meta = file_read_bounded(&meta_path, META_BYTES_MAX)?;

    let notes = if notes_path.is_file() {
        Some(file_read_bounded(&notes_path, NOTES_BYTES_MAX)?)
    } else {
        None
    };

    let transcript = match engines_for_job(id)?.first() {
        Some(engine_id) => {
            let file_name = format!("{TRANSCRIPT_FILE_PREFIX}{engine_id}{TRANSCRIPT_FILE_SUFFIX}");

            Some(file_read_bounded(&directory.join(file_name), TRANSCRIPT_BYTES_MAX)?)
        }
        None => None,
    };

    assert!(meta.len() <= usize_of!(META_BYTES_MAX));
    assert!(directory.ends_with(id));

    Ok(Some(JobFiles { meta, notes, transcript }))
}

pub(crate) fn job_id_from_source_content(source: &Path) -> AppResult<String> {
    let mut file = fs::File::open(source)?;
    let mut block = vec![0_u8; usize_of!(HASH_BUFFER_BYTES)];
    let block_bytes = u64::try_from(block.len()).unwrap_or(u64::MAX);
    let block_count_max = file.metadata()?.len().div_ceil(block_bytes) + 1;
    let mut hasher = Sha256::new();
    let mut source_bytes_hashed: u64 = 0;
    let mut source_exhausted = false;

    for _block_index in 0..block_count_max {
        let read = file.read(&mut block)?;

        if read == 0 {
            source_exhausted = true;

            break;
        }

        let block_read = block
            .get(..read)
            .ok_or_else(|| AppError::IO(std::io::Error::other("read past the hash block")))?;

        hasher.update(block_read);

        source_bytes_hashed =
            source_bytes_hashed.saturating_add(u64::try_from(read).unwrap_or(u64::MAX));
    }

    if !source_exhausted {
        return Err(AppError::IO(std::io::Error::other(format!(
            "{} grew while it was being hashed",
            source.display(),
        ))));
    }

    tracing::debug!(
        target: "remi_lib::workspace",
        "hashed {} bytes of {}",
        source_bytes_hashed,
        source.display(),
    );

    Ok(job_id_from_digest(&hasher.finalize()))
}

pub(crate) fn job_id_from_text(text: &str) -> String {
    let mut hasher = Sha256::new();

    hasher.update(text.as_bytes());

    job_id_from_digest(&hasher.finalize())
}

pub(crate) fn job_id_validate(id: &str) -> AppResult<()> {
    if job_id_is_valid(id) {
        return Ok(());
    }

    Err(AppError::Config(format!("{id:?} is not a job id")))
}

pub(crate) fn job_meta_path(id: &str) -> AppResult<PathBuf> {
    Ok(job_directory(id)?.join(META_FILE_NAME))
}

pub(crate) fn job_notes_path(id: &str) -> AppResult<PathBuf> {
    Ok(job_directory(id)?.join(NOTES_FILE_NAME))
}

pub(crate) fn job_transcript_path(slot: &TranscriptSlot<'_>) -> AppResult<PathBuf> {
    let engine_safe = sanitize_segment(slot.engine_id);

    assert_eq!(engine_safe.chars().count(), slot.engine_id.chars().count());

    let file_name = format!("{TRANSCRIPT_FILE_PREFIX}{engine_safe}{TRANSCRIPT_FILE_SUFFIX}");

    Ok(job_directory(slot.job_id)?.join(file_name))
}

pub(crate) fn jobs_directory() -> AppResult<PathBuf> {
    let path = root()?.join(JOBS_FOLDER);

    fs::create_dir_all(&path)?;

    assert!(path.ends_with(JOBS_FOLDER));

    Ok(path)
}

pub(crate) fn jobs_list_all() -> AppResult<Vec<JobMeta>> {
    let directory = jobs_directory()?;
    let mut jobs: Vec<JobMeta> = Vec::new();

    for (entry_index, listed) in fs::read_dir(directory)?.enumerate() {
        if entry_index >= usize_of!(JOB_COUNT_MAX) {
            return Err(AppError::Config(format!(
                "the jobs folder holds more than the {JOB_COUNT_MAX} recordings this app lists",
            )));
        }

        let entry = listed?;

        if !entry.file_type()?.is_dir() {
            continue;
        }

        let meta_path = entry.path().join(META_FILE_NAME);

        if !meta_path.exists() {
            continue;
        }

        match jobs_list_entry_load(&meta_path) {
            Ok(meta) => jobs.push(meta),
            Err(error) => {
                tracing::warn!(path = %meta_path.display(), %error, "job metadata unreadable");
            }
        }
    }

    jobs.sort_by_key(|job| std::cmp::Reverse(job.created_at_unix));

    assert!(jobs.len() <= usize_of!(JOB_COUNT_MAX));

    Ok(jobs)
}

pub(crate) fn jobs_listing_all() -> AppResult<Vec<JobListing>> {
    let jobs = jobs_list_all()?;
    let job_count = jobs.len();
    let mut listings: Vec<JobListing> = Vec::with_capacity(job_count);

    for meta in jobs {
        listings.push(job_listing_build(meta)?);
    }

    assert_eq!(listings.len(), job_count);

    Ok(listings)
}

pub(crate) fn meta_apply_patch(id: &str, patch: JobMetaPatch) -> AppResult<JobMeta> {
    let mut meta =
        meta_load(id)?.ok_or_else(|| AppError::Config(format!("job not found: {id}")))?;

    if meta.id != id {
        return Err(AppError::Config(format!(
            "the folder for job {id} holds metadata for job {}",
            meta.id,
        )));
    }

    if let Some(title) = patch.title {
        meta.title = text_clean(&title);
    }

    if let Some(attendees) = patch.attendees {
        meta.attendees = names_clean(attendees);
    }

    if let Some(person_ids) = patch.person_ids {
        meta.person_ids = ids_clean(person_ids);
    }

    if let Some(person_ids_mentioned) = patch.person_ids_mentioned {
        meta.person_ids_mentioned = ids_clean(person_ids_mentioned);
    }

    if let Some(project) = patch.project {
        meta.project = text_clean(&project);
    }

    if let Some(tags) = patch.tags {
        meta.tags = names_clean(tags);
    }

    if let Some(favourite) = patch.favourite {
        meta.favourite = favourite;
    }

    assert_eq!(meta.id, id);

    meta_save(&meta)?;

    Ok(meta)
}

pub(crate) fn meta_load(id: &str) -> AppResult<Option<JobMeta>> {
    let path = job_meta_path(id)?;

    if !path.exists() {
        return Ok(None);
    }

    let meta: JobMeta = serde_json::from_str(&file_read_bounded(&path, META_BYTES_MAX)?)?;

    if meta.id.is_empty() {
        return Err(AppError::Config(format!("the metadata of job {id} carries no id")));
    }

    Ok(Some(meta))
}

pub(crate) fn meta_save(meta: &JobMeta) -> AppResult<()> {
    let path = job_meta_path(&meta.id)?;

    atomic_write(&path, serde_json::to_string_pretty(meta)?.as_bytes())?;
    index_refresh(&meta.id);

    Ok(())
}

pub(crate) fn notes_load(id: &str) -> AppResult<Option<String>> {
    let path = job_notes_path(id)?;

    if !path.exists() {
        return Ok(None);
    }

    Ok(Some(file_read_bounded(&path, NOTES_BYTES_MAX)?))
}

pub(crate) fn notes_save(id: &str, markdown: &[u8]) -> AppResult<()> {
    if markdown.len() > usize_of!(NOTES_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "these notes are {} bytes, over the {NOTES_BYTES_MAX} bytes this app keeps",
            markdown.len(),
        )));
    }

    let path = job_notes_path(id)?;

    atomic_write(&path, markdown)?;
    index_refresh(id);

    Ok(())
}

pub(crate) fn root() -> AppResult<PathBuf> {
    #[cfg(test)]
    if let Some(path) = test_support::root_override() {
        return Ok(path);
    }

    let data_directory = dirs::data_dir()
        .ok_or_else(|| AppError::Config("could not resolve the data directory".into()))?;

    let path = data_directory.join(crate::APP_DATA_FOLDER);

    assert!(path.ends_with(crate::APP_DATA_FOLDER));

    Ok(path)
}

pub(crate) fn root_file_path(file_name: &str) -> AppResult<PathBuf> {
    assert_ne!(file_name, "");
    assert!(!file_name.contains(['/', '\\']));

    let directory = root()?;

    fs::create_dir_all(&directory)?;

    let path = directory.join(file_name);

    assert!(path.ends_with(file_name));

    Ok(path)
}

pub(crate) fn pcm16_append(writer: &mut PcmWriter, samples: &[f32]) -> AppResult<()> {
    let sample_rate = writer.spec().sample_rate;

    assert!(sample_rate > 0);
    assert_eq!(u32::from(writer.spec().bits_per_sample), PCM16_SAMPLE_BYTES * 8);

    let writer_length_before = writer.len();
    let samples_max = AUDIO_SECONDS_MAX * u64::from(sample_rate);

    let count = u32::try_from(samples.len())
        .ok()
        .filter(|count| u64::from(writer_length_before) + u64::from(*count) <= samples_max)
        .ok_or_else(|| {
            AppError::Audio(format!(
                "the audio is longer than the {AUDIO_HOURS_MAX} hours this app keeps",
            ))
        })?;

    let mut block = writer.get_i16_writer(count);

    for value in samples_to_pcm16(samples) {
        block.write_sample(value);
    }

    block.flush().map_err(|error| AppError::Audio(format!("wav write: {error}")))?;

    assert_eq!(writer.len(), writer_length_before + count);

    Ok(())
}

pub(crate) fn samples_to_pcm16(samples: &[f32]) -> impl Iterator<Item = i16> {
    samples.iter().map(|sample| {
        let value = (sample.clamp(-1.0, 1.0) * f32::from(i16::MAX)).to_i16().unwrap_or(0);

        assert!(value > i16::MIN);

        value
    })
}

pub(crate) fn transcript_load<T: for<'de> Deserialize<'de>>(
    slot: &TranscriptSlot<'_>,
) -> AppResult<Option<T>> {
    let path = job_transcript_path(slot)?;

    if !path.exists() {
        return Ok(None);
    }

    Ok(Some(serde_json::from_str(&file_read_bounded(&path, TRANSCRIPT_BYTES_MAX)?)?))
}

pub(crate) fn transcript_save<T: Serialize>(
    slot: &TranscriptSlot<'_>,
    transcript: &T,
) -> AppResult<()> {
    let path = job_transcript_path(slot)?;

    atomic_write(&path, serde_json::to_string_pretty(transcript)?.as_bytes())?;
    index_refresh(slot.job_id);

    Ok(())
}

pub(crate) fn transcript_save_edited<T: Serialize>(id: &str, transcript: &T) -> AppResult<()> {
    let engines = engines_for_job(id)?;

    let Some(engine_id) = engines.first() else {
        return Err(AppError::Config(format!("job {id} has no transcript to replace")));
    };

    let json = serde_json::to_string_pretty(transcript)?;

    if json.len() > usize_of!(TRANSCRIPT_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "this transcript is {} bytes, over the {TRANSCRIPT_BYTES_MAX} bytes this app keeps",
            json.len(),
        )));
    }

    let path = job_transcript_path(&TranscriptSlot { engine_id, job_id: id })?;

    atomic_write(&path, json.as_bytes())?;
    index_refresh(id);

    Ok(())
}

pub(crate) fn wav_reader_open(path: &Path) -> AppResult<hound::WavReader<BufReader<fs::File>>> {
    let reader = hound::WavReader::open(path)
        .map_err(|error| AppError::Audio(format!("wav open: {error}")))?;

    let sample_rate = reader.spec().sample_rate;

    if sample_rate == 0 {
        return Err(AppError::Audio("the recording reports a sample rate of zero".into()));
    }

    if u64::from(reader.duration()) > AUDIO_SECONDS_MAX * u64::from(sample_rate) {
        return Err(AppError::Audio(format!(
            "the recording is longer than the {AUDIO_HOURS_MAX} hours this app keeps",
        )));
    }

    Ok(reader)
}

pub(crate) fn wav_specification_mono_pcm16(sample_rate: u32) -> hound::WavSpec {
    assert!(sample_rate > 0);

    let specification = hound::WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    assert_eq!(u32::from(specification.bits_per_sample), PCM16_SAMPLE_BYTES * 8);

    specification
}

fn atomic_replace<Writer>(path: &Path, writer: Writer) -> AppResult<()>
where
    Writer: FnOnce(&Path) -> AppResult<()>,
{
    assert!(path.file_name().is_some());

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    let path_temporary =
        path.with_extension(format!("{:?}.{}", thread::current().id(), extension_temporary(path)));

    assert_ne!(path_temporary, path);

    if let Err(error) = writer(&path_temporary) {
        drop(fs::remove_file(&path_temporary));

        return Err(error);
    }

    if let Err(error) = fs::rename(&path_temporary, path) {
        drop(fs::remove_file(&path_temporary));

        return Err(error.into());
    }

    Ok(())
}

fn extension_temporary(path: &Path) -> String {
    let existing = path
        .extension()
        .map(|extension| extension.to_string_lossy().into_owned())
        .unwrap_or_default();

    let extension = if existing.is_empty() { "tmp".to_owned() } else { format!("{existing}.tmp") };

    assert!(extension.ends_with("tmp"));

    extension
}

fn file_oversized(path: &Path, size: u64, size_bytes_max: u32) -> AppError {
    assert!(size > 0);
    assert!(size_bytes_max > 0);

    AppError::Config(format!(
        "{} is {size} bytes, over the {size_bytes_max} bytes this app reads",
        path.display(),
    ))
}

fn ids_clean(ids: Vec<String>) -> Vec<String> {
    let ids_count_before = ids.len();
    let mut cleaned: Vec<String> = Vec::with_capacity(ids_count_before);

    for id in ids {
        let trimmed = id.trim();

        if trimmed.is_empty() {
            continue;
        }

        if cleaned.iter().any(|kept| kept == trimmed) {
            continue;
        }

        cleaned.push(trimmed.to_owned());
    }

    assert!(cleaned.len() <= ids_count_before);
    assert!(cleaned.iter().all(|id| !id.is_empty()));

    cleaned
}

fn index_refresh(id: &str) {
    assert!(job_id_is_valid(id));

    match crate::search::job_refresh(id) {
        Ok(crate::search::Refresh::Indexed) => crate::search::vector::worker_wake(),
        Ok(crate::search::Refresh::Removed | crate::search::Refresh::Unchanged) => {}
        Err(error) => {
            tracing::warn!(
                job = %id,
                %error,
                "the search index missed a change, the next start repairs it",
            );
        }
    }
}

fn job_id_from_digest(digest: &[u8]) -> String {
    assert!(digest.len() >= JOB_ID_BYTES);

    let bytes: Vec<String> =
        digest.iter().take(JOB_ID_BYTES).map(|byte| format!("{byte:02x}")).collect();

    let id = bytes.concat();

    assert_eq!(id.len(), JOB_ID_HEX_LENGTH);
    assert!(job_id_is_valid(&id));

    id
}

pub(crate) fn job_id_is_valid(id: &str) -> bool {
    if id.len() != JOB_ID_HEX_LENGTH {
        return false;
    }

    id.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn job_listing_build(meta: JobMeta) -> AppResult<JobListing> {
    assert_ne!(meta.id, "");

    let has_transcript = !engines_for_job(&meta.id)?.is_empty();
    let notes_metadata = fs::metadata(job_notes_path(&meta.id)?);
    let has_notes = notes_metadata.is_ok_and(|metadata| metadata.len() > 0);
    let audio_path = job_audio_path(&meta.id)?;

    let duration_seconds = if audio_path.exists() {
        match audio_wav_duration_seconds(&audio_path) {
            Ok(seconds) => Some(seconds),
            Err(error) => {
                tracing::warn!(job_id = %meta.id, %error, "audio duration unreadable");

                None
            }
        }
    } else {
        None
    };

    assert!(duration_seconds.is_none_or(|seconds| seconds >= 0.0_f64));

    Ok(JobListing { meta, has_transcript, has_notes, duration_seconds })
}

fn jobs_list_entry_load(meta_path: &Path) -> AppResult<JobMeta> {
    assert!(meta_path.ends_with(META_FILE_NAME));

    let raw = file_read_bounded(meta_path, META_BYTES_MAX)?;
    let meta: JobMeta = serde_json::from_str(&raw)?;

    if meta.id.is_empty() {
        return Err(AppError::Config(format!("{} carries no job id", meta_path.display())));
    }

    Ok(meta)
}

fn milliseconds_for(seconds: f64) -> u64 {
    assert!(seconds >= 0.0_f64);

    let scaled = (seconds * 1000.0).round().max(0.0);
    let milliseconds = scaled.to_u64().unwrap_or(u64::MAX);

    assert!(milliseconds > 0 || seconds < 0.001_f64);

    milliseconds
}

fn names_clean(names: Vec<String>) -> Vec<String> {
    let names_count_before = names.len();

    let cleaned: Vec<String> = names
        .into_iter()
        .map(|name| name.trim().to_owned())
        .filter(|name| !name.is_empty())
        .collect();

    assert!(cleaned.len() <= names_count_before);
    assert!(cleaned.iter().all(|name| !name.is_empty()));

    cleaned
}

fn sample_index_clamp(value: f64, length: u32) -> u32 {
    assert!(value >= 0.0_f64);
    assert!(f64::from(length) >= 0.0_f64);

    let scaled = value.clamp(0.0, f64::from(length));
    let index = scaled.to_u32().unwrap_or(0);

    assert!(index <= length);

    index
}

fn sanitize_segment(segment: &str) -> String {
    let sanitized: String = segment
        .chars()
        .map(|character| {
            if character.is_alphanumeric() {
                return character;
            }

            if matches!(character, '-' | '_' | '.') {
                return character;
            }

            '_'
        })
        .collect();

    assert_eq!(sanitized.chars().count(), segment.chars().count());
    assert!(!sanitized.contains(['/', '\\']));

    sanitized
}

fn text_clean(text: &str) -> Option<String> {
    let trimmed = text.trim();

    if trimmed.is_empty() {
        return None;
    }

    assert!(!trimmed.starts_with(' '));
    assert!(!trimmed.ends_with(' '));

    Some(trimmed.to_owned())
}

fn transcript_file_is_blank(path: &Path) -> bool {
    assert!(path.file_name().is_some());

    let small =
        fs::metadata(path).is_ok_and(|metadata| metadata.len() <= TRANSCRIPT_BLANK_BYTES_MAX);

    if !small {
        return false;
    }

    fs::read_to_string(path).is_ok_and(|raw| {
        serde_json::from_str::<crate::transcription::types::Transcript>(&raw)
            .is_ok_and(|transcript| transcript.text.trim().is_empty())
    })
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::JobMeta;
    use std::cell::RefCell;
    use std::fs;
    use std::path::PathBuf;
    use std::thread;

    thread_local! {
        static ROOT_INHERITED: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    }

    pub(crate) struct RootScope {
        path: PathBuf,
    }

    impl Drop for RootScope {
        fn drop(&mut self) {
            drop(fs::remove_dir_all(&self.path));
        }
    }

    pub(crate) fn meta_with(id: &str, created_at_unix: i64) -> JobMeta {
        assert_ne!(id, "");
        assert!(created_at_unix > 0);

        JobMeta {
            id: id.to_owned(),
            source_path: "/tmp/source.wav".to_owned(),
            source_size_bytes: 3,
            created_at_unix,
            recorded_at_unix: None,
            label: None,
            title: None,
            attendees: Vec::new(),
            person_ids: Vec::new(),
            person_ids_mentioned: Vec::new(),
            project: None,
            tags: Vec::new(),
            favourite: false,
        }
    }

    pub(crate) fn root_adopt(inherited: Option<PathBuf>) {
        assert!(inherited.as_ref().is_none_or(|path| path.is_dir()));
        assert!(inherited.as_ref().is_none_or(|path| path.starts_with(std::env::temp_dir())));

        ROOT_INHERITED.with(|slot| drop(slot.replace(inherited)));
    }

    pub(crate) fn root_override() -> Option<PathBuf> {
        let path = root_of_thread();

        if path.is_dir() {
            return Some(path);
        }

        let inherited = ROOT_INHERITED.with(|slot| slot.borrow().clone());

        assert!(inherited.as_ref().is_none_or(|root| root != &path));

        inherited
    }

    pub(crate) fn root_scoped() -> RootScope {
        let path = root_of_thread();

        drop(fs::remove_dir_all(&path));
        fs::create_dir_all(&path).unwrap();

        RootScope { path }
    }

    fn root_of_thread() -> PathBuf {
        let folder = format!("remi-test-{}-{:?}", std::process::id(), thread::current().id());

        std::env::temp_dir().join(folder)
    }
}

#[cfg(test)]
mod tests {
    use super::test_support::{meta_with, root_scoped};
    use super::*;
    use crate::transcription::types::{Transcript, TranscriptSegment};

    fn transcript_with(text: &str) -> Transcript {
        Transcript {
            text: text.to_owned(),
            segments: vec![TranscriptSegment {
                text: text.to_owned(),
                start_seconds: 0.0,
                end_seconds: 1.0,
            }],
        }
    }

    #[test]
    fn the_data_folders_are_created_on_first_use() {
        let _root = root_scoped();
        let jobs = jobs_directory().unwrap();
        let settings = root_file_path("settings.json").unwrap();

        assert!(jobs.is_dir());
        assert_eq!(jobs, root().unwrap().join(JOBS_FOLDER));
        assert!(settings.parent().unwrap().is_dir());
        assert!(!settings.exists());
    }

    #[test]
    fn metadata_survives_a_round_trip_through_its_job_folder() {
        let _root = root_scoped();
        let id = job_id_from_text("meta");
        let mut meta = meta_with(&id, 10);

        meta.title = Some("Kickoff".to_owned());
        meta.tags = vec!["weekly".to_owned()];
        meta.favourite = true;

        assert!(meta_load(&id).unwrap().is_none());

        meta_save(&meta).unwrap();

        let loaded = meta_load(&id).unwrap().expect("saved meta");

        assert_eq!(loaded.id, id);
        assert_eq!(loaded.title.as_deref(), Some("Kickoff"));
        assert_eq!(loaded.tags, vec!["weekly".to_owned()]);
        assert!(loaded.favourite);
        assert_ne!(meta_load("not-a-job-id").unwrap_err().to_string(), "");
    }

    #[test]
    fn metadata_written_by_an_older_build_still_reads() {
        let raw = r#"{"id":"x","source_path":"p","source_size_bytes":1,"created_at_unix":2}"#;
        let meta: JobMeta = serde_json::from_str(raw).unwrap();
        let patch: JobMetaPatch = serde_json::from_str("{}").unwrap();

        assert!(meta.title.is_none());
        assert_eq!(meta.attendees.len(), 0);
        assert!(!meta.favourite);
        assert!(patch.title.is_none());
        assert!(patch.favourite.is_none());
    }

    #[test]
    fn a_stored_transcript_with_no_text_does_not_read_as_finished() {
        let _root = root_scoped();
        let id = job_id_from_text("blank");
        let blank = Transcript { text: "  ".to_owned(), segments: Vec::new() };

        meta_save(&meta_with(&id, 1)).unwrap();
        transcript_save(&TranscriptSlot { engine_id: "remote-a", job_id: &id }, &blank).unwrap();

        let listings = jobs_listing_all().unwrap();

        assert_eq!(listings.len(), 1);
        assert!(!listings[0].has_transcript);
        assert_eq!(engines_for_job(&id).unwrap().len(), 0);
    }

    #[test]
    fn a_listing_serializes_its_metadata_flat_beside_the_derived_fields() {
        let listing = JobListing {
            meta: meta_with("abc", 1),
            has_transcript: true,
            has_notes: false,
            duration_seconds: Some(1.5_f64),
        };

        let value = serde_json::to_value(&listing).unwrap();

        assert_eq!(value["id"], "abc");
        assert_eq!(value["has_transcript"], true);
        assert_eq!(value["has_notes"], false);
        assert_eq!(value["duration_seconds"], 1.5_f64);
    }

    #[test]
    fn notes_survive_a_round_trip_and_missing_notes_read_as_none() {
        let _root = root_scoped();
        let id = job_id_from_text("notes");

        assert!(notes_load(&id).unwrap().is_none());

        notes_save(&id, "# Notes\n\nCaf\u{e9}\n".as_bytes()).unwrap();

        assert_eq!(notes_load(&id).unwrap().as_deref(), Some("# Notes\n\nCaf\u{e9}\n"));

        let oversized = "a".repeat(usize_of!(NOTES_BYTES_MAX) + 1);

        assert!(notes_save(&id, oversized.as_bytes()).is_err());
        assert_eq!(notes_load(&id).unwrap().as_deref(), Some("# Notes\n\nCaf\u{e9}\n"));
    }

    #[test]
    fn a_transcript_is_stored_per_engine_and_listed_by_engines_for_job() {
        let _root = root_scoped();
        let id = job_id_from_text("transcript");

        assert_eq!(engines_for_job(&id).unwrap().len(), 0);

        assert!(
            transcript_load::<Transcript>(&TranscriptSlot { engine_id: "remote-a", job_id: &id })
                .unwrap()
                .is_none()
        );

        transcript_save(
            &TranscriptSlot { engine_id: "remote-b", job_id: &id },
            &transcript_with("second"),
        )
        .unwrap();

        transcript_save(
            &TranscriptSlot { engine_id: "remote-a", job_id: &id },
            &transcript_with("first"),
        )
        .unwrap();

        notes_save(&id, b"notes").unwrap();

        let engines = engines_for_job(&id).unwrap();

        let loaded =
            transcript_load::<Transcript>(&TranscriptSlot { engine_id: "remote-a", job_id: &id })
                .unwrap()
                .expect("saved");

        assert_eq!(engines, vec!["remote-a".to_owned(), "remote-b".to_owned()]);
        assert_eq!(loaded.text, "first");
        assert_eq!(loaded.segments.len(), 1);
        assert_ne!(engines_for_job("nope").unwrap_err().to_string(), "");
    }

    #[test]
    fn an_edited_transcript_replaces_the_stored_one_and_needs_one_to_replace() {
        let _root = root_scoped();
        let id = job_id_from_text("edited");

        assert!(transcript_save_edited(&id, &transcript_with("orphan")).is_err());

        transcript_save(
            &TranscriptSlot { engine_id: "imported", job_id: &id },
            &transcript_with("before"),
        )
        .unwrap();
        transcript_save_edited(&id, &transcript_with("after")).unwrap();

        let loaded =
            transcript_load::<Transcript>(&TranscriptSlot { engine_id: "imported", job_id: &id })
                .unwrap()
                .expect("saved");

        assert_eq!(loaded.text, "after");
        assert_eq!(engines_for_job(&id).unwrap(), vec!["imported".to_owned()]);
    }

    #[test]
    fn a_transcript_path_keeps_an_unsafe_engine_id_inside_the_job_folder() {
        let _root = root_scoped();
        let id = job_id_from_text("path");
        let path =
            job_transcript_path(&TranscriptSlot { engine_id: "../remote/x", job_id: &id }).unwrap();

        assert_eq!(path.file_name().unwrap(), "transcript-.._remote_x.json");
        assert_eq!(path.parent().unwrap(), jobs_directory().unwrap().join(&id));
    }

    #[test]
    fn jobs_are_listed_newest_first_and_folders_without_readable_metadata_are_skipped() {
        let _root = root_scoped();
        let ids = ["old", "new", "middle"].map(job_id_from_text);

        meta_save(&meta_with(&ids[0], 100)).unwrap();
        meta_save(&meta_with(&ids[1], 300)).unwrap();
        meta_save(&meta_with(&ids[2], 200)).unwrap();

        let jobs = jobs_directory().unwrap();

        fs::create_dir_all(jobs.join(job_id_from_text("no-meta"))).unwrap();
        fs::write(jobs.join("stray.txt"), b"x").unwrap();
        fs::write(job_meta_path(&job_id_from_text("broken")).unwrap(), b"{not json").unwrap();

        let listed: Vec<String> = jobs_list_all().unwrap().into_iter().map(|job| job.id).collect();

        assert_eq!(listed, vec![ids[1].clone(), ids[2].clone(), ids[0].clone()]);
    }

    #[test]
    fn a_listing_reports_transcript_notes_and_audio_duration_per_job() {
        let _root = root_scoped();
        let full = job_id_from_text("full");
        let bare = job_id_from_text("bare");

        meta_save(&meta_with(&full, 2)).unwrap();
        meta_save(&meta_with(&bare, 1)).unwrap();

        transcript_save(
            &TranscriptSlot { engine_id: "imported", job_id: &full },
            &transcript_with("hello"),
        )
        .unwrap();

        notes_save(&full, b"notes").unwrap();
        notes_save(&bare, b"").unwrap();

        let samples = vec![0.0_f32; 8000];

        audio_wav_save(&samples, 16000, &job_audio_path(&full).unwrap()).unwrap();
        fs::write(job_audio_path(&bare).unwrap(), b"not a wav").unwrap();

        let listings = jobs_listing_all().unwrap();

        assert_eq!(listings.len(), 2);
        assert_eq!(listings[0].meta.id, full);
        assert!(listings[0].has_transcript);
        assert!(listings[0].has_notes);
        assert!((listings[0].duration_seconds.unwrap() - 0.5).abs() < 1e-9_f64);
        assert_eq!(listings[1].meta.id, bare);
        assert!(!listings[1].has_transcript);
        assert!(!listings[1].has_notes);
        assert!(listings[1].duration_seconds.is_none());
    }

    #[test]
    fn deleting_a_job_removes_its_folder_and_a_missing_one_is_not_an_error() {
        let _root = root_scoped();
        let id = job_id_from_text("delete");

        meta_save(&meta_with(&id, 1)).unwrap();
        notes_save(&id, b"notes").unwrap();

        let directory = jobs_directory().unwrap().join(&id);

        assert!(directory.exists());

        job_delete(&id).unwrap();

        assert!(!directory.exists());
        assert!(meta_load(&id).unwrap().is_none());

        job_delete(&id).unwrap();

        assert!(job_delete("../jobs").is_err());
    }

    #[test]
    fn a_patch_updates_only_the_fields_it_carries_and_is_refused_for_a_foreign_folder() {
        let _root = root_scoped();
        let id = job_id_from_text("patch");
        let foreign = job_id_from_text("foreign");
        let mut meta = meta_with(&id, 1);

        meta.title = Some("Before".to_owned());
        meta.project = Some("Website".to_owned());
        meta_save(&meta).unwrap();

        let patch = JobMetaPatch {
            title: Some("  After  ".to_owned()),
            tags: Some(vec![" weekly ".to_owned(), String::new()]),
            favourite: Some(true),
            ..JobMetaPatch::empty()
        };

        let patched = meta_apply_patch(&id, patch).unwrap();
        let encoded = serde_json::to_string(&meta).unwrap();

        atomic_write(&job_meta_path(&foreign).unwrap(), encoded.as_bytes()).unwrap();

        assert_eq!(patched.title.as_deref(), Some("After"));
        assert_eq!(patched.project.as_deref(), Some("Website"));
        assert_eq!(patched.tags, vec!["weekly".to_owned()]);
        assert!(patched.favourite);
        assert_eq!(meta_load(&id).unwrap().unwrap().title.as_deref(), Some("After"));

        assert_ne!(
            meta_apply_patch(&job_id_from_text("absent"), JobMetaPatch::empty())
                .unwrap_err()
                .to_string(),
            "",
        );

        assert_ne!(meta_apply_patch(&foreign, JobMetaPatch::empty()).unwrap_err().to_string(), "");
    }

    #[test]
    fn an_atomic_write_replaces_the_file_in_place_and_leaves_no_temporary_behind() {
        let _root = root_scoped();
        let path = root().unwrap().join("nested").join("notes.md");
        let blocked = root().unwrap().join("blocked");

        atomic_write(&path, b"first").unwrap();
        atomic_write(&path, b"second").unwrap();
        fs::create_dir_all(&blocked).unwrap();

        let names: Vec<String> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();

        assert_eq!(fs::read_to_string(&path).unwrap(), "second");
        assert_eq!(names, vec!["notes.md".to_owned()]);
        assert!(atomic_write(&blocked, b"x").is_err());
        assert!(!blocked.with_extension("tmp").exists());

        let leftovers = fs::read_dir(root().unwrap())
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with("tmp"));

        assert_eq!(leftovers.count(), 0);
    }

    #[test]
    fn audio_survives_a_round_trip_through_a_pcm16_wav_file() {
        let _root = root_scoped();
        let path = root().unwrap().join("audio.wav");
        let samples = [0.0_f32, 0.5, -0.5, 1.0, -1.0];

        audio_wav_save(&samples, 8000, &path).unwrap();

        let (loaded, sample_rate) = audio_wav_load(&path).unwrap();
        let duration_seconds = audio_wav_duration_seconds(&path).unwrap();

        assert_eq!(sample_rate, 8000);
        assert_eq!(loaded.len(), samples.len());
        assert!((duration_seconds - 5.0 / 8000.0).abs() < 1e-9_f64);

        for (original, decoded) in samples.iter().zip(&loaded) {
            assert!((original - decoded).abs() < 1.0 / f32::from(i16::MAX));
        }
    }

    #[test]
    fn audio_past_the_length_gate_is_refused_and_a_non_wav_file_does_not_open() {
        let _root = root_scoped();
        let path = root().unwrap().join("audio.wav");
        let at_limit = vec![0.0_f32; usize::try_from(AUDIO_SECONDS_MAX).unwrap()];
        let past_limit = vec![0.0_f32; usize::try_from(AUDIO_SECONDS_MAX).unwrap() + 1];

        assert!(audio_wav_save(&past_limit, 1, &path).is_err());
        audio_wav_save(&at_limit, 1, &path).unwrap();
        drop(wav_reader_open(&path).unwrap());

        fs::write(&path, b"RIFF but not really").unwrap();

        assert!(wav_reader_open(&path).is_err());
        assert_ne!(audio_wav_duration_seconds(&path).unwrap_err().to_string(), "");
        assert_ne!(audio_wav_load(&path).unwrap_err().to_string(), "");
    }

    #[test]
    fn a_source_file_hashes_to_the_same_id_as_its_text() {
        let _root = root_scoped();
        let path = root().unwrap().join("source.txt");
        let multi_block = "x".repeat(usize_of!(HASH_BUFFER_BYTES) * 2 + 1);

        fs::write(&path, b"hello").unwrap();

        assert_eq!(job_id_from_source_content(&path).unwrap(), job_id_from_text("hello"));

        fs::write(&path, b"").unwrap();

        assert_eq!(job_id_from_source_content(&path).unwrap(), job_id_from_text(""));

        fs::write(&path, &multi_block).unwrap();

        assert_eq!(job_id_from_source_content(&path).unwrap(), job_id_from_text(&multi_block));

        assert_ne!(
            job_id_from_source_content(&root().unwrap().join("missing")).unwrap_err().to_string(),
            "",
        );
    }

    #[test]
    fn a_missing_file_is_an_error_and_an_empty_one_reads_as_empty() {
        let _root = root_scoped();
        let path = root().unwrap().join("empty.txt");

        assert_ne!(file_read_bounded(&path, 1).unwrap_err().to_string(), "");

        fs::write(&path, b"").unwrap();

        assert_eq!(file_read_bounded(&path, 1).unwrap(), "");
    }

    #[test]
    fn names_keep_their_order_and_duplicates_while_ids_are_deduplicated() {
        let names = vec![" b ".to_owned(), "a".to_owned(), "  ".to_owned(), "a".to_owned()];
        let ids = vec!["b".to_owned(), "a".to_owned(), "b".to_owned()];

        assert_eq!(names_clean(names), vec!["b".to_owned(), "a".to_owned(), "a".to_owned()]);
        assert_eq!(ids_clean(ids), vec!["b".to_owned(), "a".to_owned()]);
        assert_eq!(names_clean(Vec::new()).len(), 0);
    }

    #[test]
    fn job_id_is_the_first_32_hex_chars_of_the_sha256() {
        let id = job_id_from_text("hello");

        assert_eq!(id, "2cf24dba5fb0a30e26e83b2ac5b9e29e");
        assert_eq!(id.len(), JOB_ID_HEX_LENGTH);
    }

    #[test]
    fn only_a_minted_job_id_shape_is_accepted_back() {
        job_id_validate("2cf24dba5fb0a30e26e83b2ac5b9e29e").unwrap();
        job_id_validate("2CF24DBA5FB0A30E26E83B2AC5B9E29E").unwrap();
        assert!(job_id_validate("").is_err());
        assert!(job_id_validate("../../etc").is_err());
        assert!(job_id_validate("2cf24dba5fb0a30e26e83b2ac5b9e29").is_err());
        assert!(job_id_validate("2cf24dba5fb0a30e26e83b2ac5b9e29g").is_err());
    }

    #[test]
    fn a_temporary_file_keeps_the_original_extension_in_its_name() {
        assert_eq!(extension_temporary(Path::new("notes.md")), "md.tmp");
        assert_eq!(extension_temporary(Path::new("meta.json")), "json.tmp");
        assert_eq!(extension_temporary(Path::new("endpoint_keys")), "tmp");
    }

    #[test]
    fn a_file_segment_keeps_only_safe_characters() {
        assert_eq!(sanitize_segment("remote-builtin_notes.v1"), "remote-builtin_notes.v1");
        assert_eq!(sanitize_segment("../escape"), ".._escape");
    }

    #[test]
    fn a_file_past_its_size_gate_is_refused_rather_than_read() {
        let path =
            std::env::temp_dir().join(format!("remi-bounded-read-test-{}.txt", std::process::id()));

        fs::write(&path, b"0123456789").unwrap();

        assert_eq!(file_read_bounded(&path, 10).unwrap(), "0123456789");
        assert_ne!(file_read_bounded(&path, 9).unwrap_err().to_string(), "");

        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn a_patch_trims_text_and_drops_empty_values() {
        assert_eq!(text_clean("  Kickoff "), Some("Kickoff".to_owned()));
        assert_eq!(text_clean("   "), None);
        assert_eq!(ids_clean(vec![" a ".into(), "a".into(), String::new()]), vec!["a".to_owned()]);
    }

    #[test]
    fn a_sample_is_scaled_into_the_symmetric_pcm16_range() {
        let samples = [1.0, -1.0, 0.0, 2.0, -2.0, f32::NAN, f32::INFINITY];
        let values: Vec<i16> = samples_to_pcm16(&samples).collect();

        assert_eq!(values.len(), samples.len());
        assert_eq!(values, vec![i16::MAX, -i16::MAX, 0, i16::MAX, -i16::MAX, 0, i16::MAX]);
        assert!(values.iter().all(|value| *value > i16::MIN));
    }

    #[test]
    fn metadata_without_an_id_is_an_error_and_leaves_the_listing_intact() {
        let _root = root_scoped();
        let blank = job_id_from_text("blank");
        let intact = job_id_from_text("intact");
        let raw = r#"{"id":"","source_path":"p","source_size_bytes":1,"created_at_unix":2}"#;

        fs::write(job_meta_path(&blank).unwrap(), raw).unwrap();
        meta_save(&meta_with(&intact, 1)).unwrap();

        let listed: Vec<String> = jobs_list_all().unwrap().into_iter().map(|job| job.id).collect();

        assert_ne!(meta_load(&blank).unwrap_err().to_string(), "");
        assert_eq!(listed, vec![intact]);
    }

    #[test]
    fn overlapping_atomic_writes_leave_one_whole_file_and_no_temporary() {
        let _root = root_scoped();
        let directory = root().unwrap();
        let path = directory.join("notes.md");

        thread::scope(|scope| {
            for writer in 0_u8..8 {
                let target = &path;

                let _handle = scope.spawn(move || {
                    let contents = vec![b'a' + writer; 64 * 1024];

                    for _round in 0_u8..50 {
                        atomic_write(target, &contents).unwrap();
                    }
                });
            }
        });

        let written = fs::read(&path).unwrap();

        assert_eq!(written.len(), 64 * 1024);
        assert!(written.iter().all(|byte| *byte == written[0]));
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
        assert!(written[0] >= b'a');
        assert!(written[0] < b'a' + 8);
        assert_eq!(fs::read_to_string(&path).unwrap().len(), written.len());
    }

    #[test]
    fn a_clip_span_needs_a_start_at_or_past_zero_and_an_end_after_it() {
        let span = ClipSpan::of(ClipStart(0.0), ClipEnd(1.0)).unwrap();

        assert!(span.end_seconds > span.start_seconds);
        assert_ne!(ClipSpan::of(ClipStart(1.0), ClipEnd(1.0)).unwrap_err().to_string(), "");
        assert_ne!(ClipSpan::of(ClipStart(-1.0), ClipEnd(1.0)).unwrap_err().to_string(), "");
        assert_ne!(ClipSpan::of(ClipStart(2.0), ClipEnd(1.0)).unwrap_err().to_string(), "");
    }
}
