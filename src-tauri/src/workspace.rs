use crate::contract::{ClipEnd, ClipStart};
use crate::error::{AppError, AppResult};
use num_traits::ToPrimitive;
use serde::{Deserialize, Deserializer, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::{BufReader, BufWriter, ErrorKind, Read};
use std::ops::RangeInclusive;
use std::path::{Path, PathBuf};
use std::thread;

const AUDIO_FILE_NAME: &str = "audio.wav";
pub(crate) const AUDIO_HOURS_MAX: u64 = 6;
pub(crate) const AUDIO_SECONDS_MAX: u64 = AUDIO_HOURS_MAX * 60 * 60;
const CLIP_FILE_PREFIX: &str = "clip-";
const CREATED_AT_UNIX_RANGE: RangeInclusive<i64> = 0..=SAFE_INTEGER_MAX;
const ENGINE_COUNT_MAX: u32 = 16;
#[cfg(not(windows))]
const FILE_MODE_PRIVATE: u32 = 0o600;
const HASH_BUFFER_BYTES: u32 = 64 * 1024;
pub(crate) const JOB_COUNT_MAX: u32 = 4096;
const JOB_ENTRIES_MAX: u32 = JOB_COUNT_MAX * 4;
const JOB_ID_BYTES: usize = 16;
const JOB_ID_HEX_LENGTH: usize = JOB_ID_BYTES * 2;
const JOBS_FOLDER: &str = "jobs";
const JOBS_LOCK_FILE_NAME: &str = "jobs.lock";

const MESSAGE_AUDIO_UNSAVED: &str =
    "the audio could not be saved to disk; check that the disk has free space";

const META_BYTES_MAX: u32 = 64 << 10;
const META_FILE_NAME: &str = "meta.json";
pub(crate) const NOTES_BYTES_MAX: u32 = 4 << 20;
const NOTES_FILE_NAME: &str = "notes.md";
pub(crate) const PCM16_SAMPLE_BYTES: u32 = 2;
const SAFE_INTEGER_MAX: i64 = (1 << 53) - 1;
const TRANSCRIPT_BLANK_BYTES_MAX: u64 = 64;
const TRANSCRIPT_BYTES_MAX: u32 = 64 << 20;
const TRANSCRIPT_FILE_PREFIX: &str = "transcript-";
const TRANSCRIPT_FILE_SUFFIX: &str = ".json";

const _: () = assert!(JOB_COUNT_MAX < JOB_ENTRIES_MAX);
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
    #[serde(default)]
    pub(crate) attendees: Vec<String>,
    #[serde(deserialize_with = "created_at_unix_deserialize")]
    pub(crate) created_at_unix: i64,
    #[serde(default)]
    pub(crate) favourite: bool,
    pub(crate) id: String,
    #[serde(default)]
    pub(crate) label: Option<String>,
    #[serde(default)]
    pub(crate) person_ids: Vec<String>,
    #[serde(default)]
    pub(crate) person_ids_mentioned: Vec<String>,
    #[serde(default)]
    pub(crate) project: Option<String>,
    #[serde(default)]
    pub(crate) recorded_at_unix: Option<i64>,
    pub(crate) source_path: String,
    pub(crate) source_size_bytes: u64,
    #[serde(default)]
    pub(crate) tags: Vec<String>,
    #[serde(default)]
    pub(crate) title: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct JobListing {
    pub(crate) duration_seconds: Option<f64>,
    pub(crate) has_notes: bool,
    pub(crate) has_transcript: bool,
    #[serde(flatten)]
    pub(crate) meta: JobMeta,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct JobMetaPatch {
    #[serde(default)]
    pub(crate) attendees: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) favourite: Option<bool>,
    #[serde(default)]
    pub(crate) person_ids: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) person_ids_mentioned: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) project: Option<String>,
    #[serde(default)]
    pub(crate) tags: Option<Vec<String>>,
    #[serde(default)]
    pub(crate) title: Option<String>,
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
            return Err(AppError::Internal("a clip needs a positive time range".into()));
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
    parent_create(path)?;

    atomic_replace(path, |path_temporary| Ok(fs::write(path_temporary, contents)?))
}

#[cfg(not(windows))]
pub(crate) fn atomic_write_private(path: &Path, contents: &[u8]) -> AppResult<()> {
    use std::fs::{OpenOptions, Permissions};
    use std::io::Write as _;
    use std::os::unix::fs::{OpenOptionsExt as _, PermissionsExt as _};

    assert!(path.file_name().is_some());

    parent_create(path)?;

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

pub(crate) fn audio_clip_save(id: &str, paths: &ClipPaths<'_>, span: ClipSpan) -> AppResult<()> {
    assert!(span.start_seconds >= 0.0_f64);
    assert!(span.end_seconds > span.start_seconds);

    let mut reader = wav_reader_open(paths.source)?;
    let specification = reader.spec();
    let rate = f64::from(specification.sample_rate);
    let length = reader.len();
    let sample_start = sample_index_clamp((span.start_seconds * rate).floor(), length);
    let sample_end = sample_index_clamp((span.end_seconds * rate).ceil(), length);

    if sample_end <= sample_start {
        return Err(AppError::Internal("the clip lies past the end of the audio".into()));
    }

    reader.seek(sample_start).map_err(|error| AppError::Internal(format!("wav seek: {error}")))?;

    let sample_count = usize::try_from(sample_end - sample_start).unwrap_or(usize::MAX);

    job_file_replace(id, paths.clip, |output| {
        audio_wav_write(output, specification, |writer| {
            for sample in reader.samples::<i16>().take(sample_count) {
                let value =
                    sample.map_err(|error| AppError::Internal(format!("wav read: {error}")))?;

                writer.write_sample(value).map_err(|error| wav_write_failure("write", &error))?;
            }

            Ok(())
        })
    })
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

    let samples = read.map_err(|error| AppError::Internal(format!("wav read: {error}")))?;

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

#[cfg(test)]
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

        audio_wav_write(fs::File::create(path_temporary)?, specification, fill)
    })
}

pub(crate) fn created_at_unix_now() -> i64 {
    let clock_unix = chrono::Utc::now().timestamp();
    let created_at_unix = clock_unix.clamp(0, SAFE_INTEGER_MAX);

    if CREATED_AT_UNIX_RANGE.contains(&clock_unix) {
        assert_eq!(created_at_unix, clock_unix);
    }

    assert!(CREATED_AT_UNIX_RANGE.contains(&created_at_unix));

    created_at_unix
}

pub(crate) fn engines_for_job(id: &str) -> AppResult<Vec<String>> {
    let directory = job_directory(id)?;

    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };

    let mut engines: Vec<String> = Vec::new();

    for listed in entries {
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
            return Err(AppError::Internal(format!(
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
    let directory = job_directory(id)?;
    let _lock = jobs_lock()?;

    job_present_validate(id)?;

    for entry in fs::read_dir(directory)? {
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

pub(crate) fn job_audio_save_streamed<Fill>(id: &str, sample_rate: u32, fill: Fill) -> AppResult<()>
where
    Fill: FnOnce(&mut PcmWriter) -> AppResult<()>,
{
    assert!(sample_rate > 0);

    let path = job_audio_path(id)?;
    let specification = wav_specification_mono_pcm16(sample_rate);

    job_file_replace(id, &path, |output| audio_wav_write(output, specification, fill))
}

pub(crate) fn job_delete(id: &str) -> AppResult<()> {
    let directory = job_directory(id)?;
    let lock = jobs_lock()?;

    if directory.exists() {
        fs::remove_dir_all(&directory)?;
    }

    assert!(!directory.exists());

    drop(lock);
    index_refresh(id);

    Ok(())
}

pub(crate) fn job_directory(id: &str) -> AppResult<PathBuf> {
    job_id_validate(id)?;

    let path = jobs_directory()?.join(id);

    assert!(path.ends_with(id));

    Ok(path)
}

pub(crate) fn job_file_write(id: &str, path: &Path, contents: &[u8]) -> AppResult<()> {
    use std::io::Write as _;

    job_file_replace(id, path, |mut file| Ok(file.write_all(contents)?))
}

pub(crate) fn job_files_load(id: &str) -> AppResult<Option<JobFiles>> {
    job_id_validate(id)?;

    let directory = jobs_directory()?.join(id);
    let meta_path = directory.join(META_FILE_NAME);
    let notes_path = directory.join(NOTES_FILE_NAME);

    let Some(meta) = file_read_if_present(&meta_path, META_BYTES_MAX)? else {
        return Ok(None);
    };

    let notes = file_read_if_present(&notes_path, NOTES_BYTES_MAX)?;

    let transcript = match engines_for_job(id)?.first() {
        Some(engine_id) => {
            let file_name = format!("{TRANSCRIPT_FILE_PREFIX}{engine_id}{TRANSCRIPT_FILE_SUFFIX}");

            file_read_if_present(&directory.join(file_name), TRANSCRIPT_BYTES_MAX)?
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

    Err(AppError::Internal(format!("{id:?} is not a job id")))
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
    let meta_paths = jobs_meta_paths()?;
    let mut jobs: Vec<JobMeta> = Vec::with_capacity(meta_paths.len());

    for meta_path in &meta_paths {
        match jobs_list_entry_load(meta_path) {
            Ok(meta) => jobs.push(meta),
            Err(error) => {
                tracing::warn!(path = %meta_path.display(), %error, "job metadata unreadable");
            }
        }
    }

    jobs.sort_by_key(|job| std::cmp::Reverse(job.created_at_unix));

    assert!(jobs.len() <= meta_paths.len());
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
    let patched = meta_update(id, |meta| {
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
    })?;

    assert_eq!(patched.id, id);

    Ok(patched)
}

pub(crate) fn meta_load(id: &str) -> AppResult<Option<JobMeta>> {
    let Some(raw) = file_read_if_present(&job_meta_path(id)?, META_BYTES_MAX)? else {
        return Ok(None);
    };

    let meta: JobMeta = serde_json::from_str(&raw)?;

    if meta.id.is_empty() {
        return Err(AppError::Internal(format!("the metadata of job {id} carries no id")));
    }

    assert!(CREATED_AT_UNIX_RANGE.contains(&meta.created_at_unix));

    Ok(Some(meta))
}

#[cfg(test)]
pub(crate) fn meta_save(meta: &JobMeta) -> AppResult<()> {
    let saved = meta_upsert(&meta.id, |_existing| meta.clone())?;

    assert_eq!(saved.id, meta.id);

    Ok(())
}

pub(crate) fn meta_update<Change>(id: &str, change: Change) -> AppResult<JobMeta>
where
    Change: FnOnce(&mut JobMeta),
{
    let lock = jobs_lock()?;

    let Some(mut meta) = meta_load(id)? else {
        return Err(job_deleted(id));
    };

    if meta.id != id {
        return Err(AppError::Internal(format!(
            "the folder for job {id} holds metadata for job {}",
            meta.id,
        )));
    }

    change(&mut meta);

    assert_eq!(meta.id, id);

    let encoded = meta_encode(&meta)?;
    let meta_path = job_meta_path(id)?;

    atomic_replace(&meta_path, |path_temporary| Ok(fs::write(path_temporary, &encoded)?))?;
    drop(lock);
    index_refresh(id);

    Ok(meta)
}

pub(crate) fn meta_upsert<Build>(id: &str, build: Build) -> AppResult<JobMeta>
where
    Build: FnOnce(Option<JobMeta>) -> JobMeta,
{
    let lock = jobs_lock()?;
    let existing = meta_load(id)?;
    let created = existing.is_none();
    let meta = build(existing);

    assert_eq!(meta.id, id);

    let encoded = meta_encode(&meta)?;

    if created {
        job_create(id)?;
    }

    let meta_path = job_meta_path(id)?;

    atomic_replace(&meta_path, |path_temporary| Ok(fs::write(path_temporary, &encoded)?))?;
    drop(lock);
    index_refresh(id);

    Ok(meta)
}

pub(crate) fn notes_load(id: &str) -> AppResult<Option<String>> {
    file_read_if_present(&job_notes_path(id)?, NOTES_BYTES_MAX)
}

pub(crate) fn notes_save(id: &str, markdown: &[u8]) -> AppResult<()> {
    if markdown.len() > usize_of!(NOTES_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "these notes are {} bytes, over the {NOTES_BYTES_MAX} bytes this app keeps",
            markdown.len(),
        )));
    }

    let path = job_notes_path(id)?;

    job_file_write(id, &path, markdown)?;
    index_refresh(id);

    Ok(())
}

pub(crate) fn root() -> AppResult<PathBuf> {
    #[cfg(test)]
    if let Some(path) = test_support::root_override() {
        return Ok(path);
    }

    let data_directory = dirs::data_dir()
        .ok_or_else(|| AppError::Internal("could not resolve the data directory".into()))?;

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

    block.flush().map_err(|error| wav_write_failure("write", &error))?;

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

    let Some(raw) = file_read_if_present(&path, TRANSCRIPT_BYTES_MAX)? else {
        return Ok(None);
    };

    Ok(Some(serde_json::from_str(&raw)?))
}

pub(crate) fn transcript_save<T: Serialize>(
    slot: &TranscriptSlot<'_>,
    transcript: &T,
) -> AppResult<()> {
    let path = job_transcript_path(slot)?;
    let json = transcript_encode(transcript)?;

    job_file_write(slot.job_id, &path, json.as_bytes())?;
    index_refresh(slot.job_id);

    Ok(())
}

pub(crate) fn transcript_save_edited<T: Serialize>(id: &str, transcript: &T) -> AppResult<()> {
    let engines = engines_for_job(id)?;

    let Some(engine_id) = engines.first() else {
        job_present_validate(id)?;

        return Err(AppError::Internal(format!("job {id} has no transcript to replace")));
    };

    let json = transcript_encode(transcript)?;
    let path = job_transcript_path(&TranscriptSlot { engine_id, job_id: id })?;

    job_file_write(id, &path, json.as_bytes())?;
    index_refresh(id);

    Ok(())
}

pub(crate) fn wav_reader_open(path: &Path) -> AppResult<hound::WavReader<BufReader<fs::File>>> {
    let reader = hound::WavReader::open(path).map_err(|error| {
        tracing::warn!("{} could not be opened: {error}", path.display());

        AppError::Audio(
            "the audio of this recording could not be opened; it may have been moved or deleted"
                .into(),
        )
    })?;

    let sample_rate = reader.spec().sample_rate;

    if sample_rate == 0 {
        return Err(AppError::Internal("the recording reports a sample rate of zero".into()));
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

    let path_temporary = path_temporary_for(path);

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

fn audio_wav_write<Fill>(
    output: fs::File,
    specification: hound::WavSpec,
    fill: Fill,
) -> AppResult<()>
where
    Fill: FnOnce(&mut PcmWriter) -> AppResult<()>,
{
    assert!(output.metadata().is_ok_and(|metadata| metadata.len() == 0));
    assert!(specification.sample_rate > 0);

    let mut writer = hound::WavWriter::new(BufWriter::new(output), specification)
        .map_err(|error| wav_write_failure("create", &error))?;

    fill(&mut writer)?;

    writer.finalize().map_err(|error| wav_write_failure("finalize", &error))
}

fn created_at_unix_deserialize<'de, Source>(source: Source) -> Result<i64, Source::Error>
where
    Source: Deserializer<'de>,
{
    assert!(source.is_human_readable());

    let created_at_unix = i64::deserialize(source)?;

    if CREATED_AT_UNIX_RANGE.contains(&created_at_unix) {
        return Ok(created_at_unix);
    }

    Err(serde::de::Error::custom(format!(
        "created_at_unix {created_at_unix} lies outside 0 to {SAFE_INTEGER_MAX}, the times this \
         app shows",
    )))
}

fn extension_temporary(path: &Path) -> String {
    let existing =
        path.extension().map_or_default(|extension| extension.to_string_lossy().into_owned());

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

fn file_read_if_present(path: &Path, size_bytes_max: u32) -> AppResult<Option<String>> {
    assert!(size_bytes_max > 0);

    match file_read_bounded(path, size_bytes_max) {
        Ok(contents) => Ok(Some(contents)),
        Err(AppError::IO(error)) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
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

fn job_create(id: &str) -> AppResult<()> {
    let directory = job_directory(id)?;

    jobs_capacity_validate()?;

    if directory.exists() {
        fs::remove_dir_all(&directory)?;
    }

    fs::create_dir_all(&directory)?;

    assert!(directory.is_dir());
    assert!(!directory.join(META_FILE_NAME).exists());

    Ok(())
}

fn job_deleted(id: &str) -> AppError {
    assert!(job_id_is_valid(id));

    AppError::Config(format!("recording {id} was deleted"))
}

fn job_file_replace<Writer>(id: &str, path: &Path, writer: Writer) -> AppResult<()>
where
    Writer: FnOnce(fs::File) -> AppResult<()>,
{
    let directory = job_directory(id)?;
    let path_temporary = path_temporary_for(path);

    assert_eq!(path.parent(), Some(directory.as_path()));

    let lock = jobs_lock()?;

    job_present_validate(id)?;

    let file = fs::File::create(&path_temporary)?;

    drop(lock);

    let replaced = writer(file).and_then(|()| {
        let _lock = jobs_lock()?;

        job_present_validate(id)?;

        Ok(fs::rename(&path_temporary, path)?)
    });

    if replaced.is_err() {
        drop(fs::remove_file(&path_temporary));
    }

    replaced
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

    Ok(JobListing { duration_seconds, has_notes, has_transcript, meta })
}

fn job_present_validate(id: &str) -> AppResult<()> {
    let meta_path = job_meta_path(id)?;

    if meta_path.is_file() {
        return Ok(());
    }

    Err(job_deleted(id))
}

fn jobs_capacity_validate() -> AppResult<()> {
    let job_count = jobs_meta_paths()?.len();

    assert!(job_count <= usize_of!(JOB_COUNT_MAX));

    if job_count < usize_of!(JOB_COUNT_MAX) {
        return Ok(());
    }

    Err(AppError::Config(format!(
        "the jobs folder already holds the {JOB_COUNT_MAX} recordings this app keeps; delete one \
         to add another",
    )))
}

fn jobs_list_entry_load(meta_path: &Path) -> AppResult<JobMeta> {
    assert!(meta_path.ends_with(META_FILE_NAME));

    let raw = file_read_bounded(meta_path, META_BYTES_MAX)?;
    let meta: JobMeta = serde_json::from_str(&raw)?;

    if meta.id.is_empty() {
        return Err(AppError::Internal(format!("{} carries no job id", meta_path.display())));
    }

    assert!(CREATED_AT_UNIX_RANGE.contains(&meta.created_at_unix));

    Ok(meta)
}

fn jobs_lock() -> AppResult<fs::File> {
    let path = root_file_path(JOBS_LOCK_FILE_NAME)?;
    let lock = fs::OpenOptions::new().create(true).truncate(false).write(true).open(&path)?;

    lock.lock()?;

    assert!(path.is_file());

    Ok(lock)
}

fn jobs_meta_paths() -> AppResult<Vec<PathBuf>> {
    let directory = jobs_directory()?;
    let mut meta_paths: Vec<PathBuf> = Vec::new();

    for (entry_index, listed) in fs::read_dir(&directory)?.enumerate() {
        if entry_index >= usize_of!(JOB_ENTRIES_MAX) {
            return Err(AppError::Config(format!(
                "the jobs folder holds more than the {JOB_ENTRIES_MAX} entries this app reads",
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

        if meta_paths.len() >= usize_of!(JOB_COUNT_MAX) {
            return Err(AppError::Config(format!(
                "the jobs folder holds more than the {JOB_COUNT_MAX} recordings this app lists",
            )));
        }

        meta_paths.push(meta_path);
    }

    assert!(meta_paths.len() <= usize_of!(JOB_COUNT_MAX));
    assert!(meta_paths.iter().all(|meta_path| meta_path.starts_with(&directory)));

    Ok(meta_paths)
}

fn meta_encode(meta: &JobMeta) -> AppResult<String> {
    assert!(CREATED_AT_UNIX_RANGE.contains(&meta.created_at_unix));

    let encoded = serde_json::to_string_pretty(meta)?;

    if encoded.len() > usize_of!(META_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "the details of this recording are {} bytes, over the {META_BYTES_MAX} bytes this \
             app keeps",
            encoded.len(),
        )));
    }

    assert!(encoded.starts_with('{'));

    Ok(encoded)
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

fn parent_create(path: &Path) -> AppResult<()> {
    let jobs = root()?.join(JOBS_FOLDER);

    assert!(!path.starts_with(&jobs));

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    Ok(())
}

fn path_temporary_for(path: &Path) -> PathBuf {
    let extension = format!("{:?}.{}", thread::current().id(), extension_temporary(path));
    let path_temporary = path.with_extension(extension);

    assert_ne!(path_temporary, path);
    assert_eq!(path_temporary.parent(), path.parent());

    path_temporary
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

fn transcript_encode<T: Serialize>(transcript: &T) -> AppResult<String> {
    let json = serde_json::to_string_pretty(transcript)?;

    if json.len() > usize_of!(TRANSCRIPT_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "this transcript is {} bytes, over the {TRANSCRIPT_BYTES_MAX} bytes this app keeps",
            json.len(),
        )));
    }

    assert!(json.starts_with('{'));
    assert!(json.ends_with('}'));

    Ok(json)
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

fn wav_write_failure(stage: &str, error: &hound::Error) -> AppError {
    assert_ne!(stage, "");

    tracing::warn!("audio {stage} failed: {error}");

    AppError::Audio(MESSAGE_AUDIO_UNSAVED.into())
}

#[cfg(test)]
pub(crate) mod test_support {
    use super::{JOB_COUNT_MAX, JobMeta, job_id_from_text, job_meta_path};
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

    pub(crate) fn jobs_filled(count: u32) -> Vec<String> {
        assert!(count > 0);
        assert!(count <= JOB_COUNT_MAX);

        let ids: Vec<String> =
            (0..count).map(|index| job_id_from_text(&format!("filled-{index}"))).collect();

        for id in &ids {
            let meta = serde_json::to_vec(&meta_with(id, 1)).unwrap();

            meta_raw_write(id, &meta);
        }

        assert_eq!(ids.len(), usize_of!(count));

        ids
    }

    pub(crate) fn meta_raw_write(id: &str, raw: &[u8]) {
        let meta_path = job_meta_path(id).unwrap();

        fs::create_dir_all(meta_path.parent().unwrap()).unwrap();
        fs::write(&meta_path, raw).unwrap();

        assert!(meta_path.is_file());
    }

    pub(crate) fn meta_with(id: &str, created_at_unix: i64) -> JobMeta {
        assert_ne!(id, "");
        assert!(created_at_unix > 0);

        JobMeta {
            attendees: Vec::new(),
            created_at_unix,
            favourite: false,
            id: id.to_owned(),
            label: None,
            person_ids: Vec::new(),
            person_ids_mentioned: Vec::new(),
            project: None,
            recorded_at_unix: None,
            source_path: "/tmp/source.wav".to_owned(),
            source_size_bytes: 3,
            tags: Vec::new(),
            title: None,
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
    use super::test_support::{
        jobs_filled,
        meta_raw_write,
        meta_with,
        root_adopt,
        root_override,
        root_scoped,
    };
    use super::*;
    use crate::transcription::types::{Transcript, TranscriptSegment};

    fn transcript_with(text: &str) -> Transcript {
        Transcript {
            segments: vec![TranscriptSegment {
                end_seconds: 1.0,
                start_seconds: 0.0,
                text: text.to_owned(),
            }],
            text: text.to_owned(),
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
        let blank = Transcript { segments: Vec::new(), text: "  ".to_owned() };

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
            duration_seconds: Some(1.5_f64),
            has_notes: false,
            has_transcript: true,
            meta: meta_with("abc", 1),
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

        meta_save(&meta_with(&id, 1)).unwrap();
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

        meta_save(&meta_with(&id, 1)).unwrap();

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

        meta_save(&meta_with(&id, 1)).unwrap();

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
        meta_raw_write(&job_id_from_text("broken"), b"{not json");

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
            favourite: Some(true),
            tags: Some(vec![" weekly ".to_owned(), String::new()]),
            title: Some("  After  ".to_owned()),
            ..JobMetaPatch::empty()
        };

        let patched = meta_apply_patch(&id, patch).unwrap();
        let encoded = serde_json::to_string(&meta).unwrap();

        meta_raw_write(&foreign, encoded.as_bytes());

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

        meta_raw_write(&blank, raw.as_bytes());
        meta_save(&meta_with(&intact, 1)).unwrap();

        let listed: Vec<String> = jobs_list_all().unwrap().into_iter().map(|job| job.id).collect();

        assert_ne!(meta_load(&blank).unwrap_err().to_string(), "");
        assert_eq!(listed, vec![intact]);
    }

    #[test]
    fn a_creation_time_outside_the_safe_integer_range_is_refused_like_any_unreadable_metadata() {
        let _root = root_scoped();
        let epoch = job_id_from_text("epoch");
        let safe = job_id_from_text("safe");
        let negative = job_id_from_text("negative");
        let oversized = job_id_from_text("oversized");

        let cases = [
            (&epoch, 0_i64),
            (&safe, 9_007_199_254_740_991_i64),
            (&negative, -1_i64),
            (&oversized, 9_007_199_254_740_992_i64),
        ];

        for (id, created_at_unix) in cases {
            let mut raw = serde_json::to_value(meta_with(id, 1)).unwrap();

            raw["created_at_unix"] = created_at_unix.into();
            meta_raw_write(id, raw.to_string().as_bytes());
        }

        let listed: Vec<String> = jobs_list_all().unwrap().into_iter().map(|job| job.id).collect();

        assert_eq!(meta_load(&epoch).unwrap().unwrap().created_at_unix, 0);
        assert_eq!(meta_load(&safe).unwrap().unwrap().created_at_unix, 9_007_199_254_740_991);
        assert!(meta_load(&negative).unwrap_err().to_string().contains("created_at_unix"));
        assert!(meta_load(&oversized).unwrap_err().to_string().contains("created_at_unix"));
        assert_eq!(listed, vec![safe, epoch]);
    }

    #[test]
    fn the_job_limit_counts_job_folders_and_not_the_other_entries_beside_them() {
        let _root = root_scoped();
        let jobs = jobs_directory().unwrap();

        drop(jobs_filled(JOB_COUNT_MAX));
        fs::write(jobs.join(".DS_Store"), b"x").unwrap();
        fs::create_dir_all(jobs.join(job_id_from_text("no-meta"))).unwrap();

        assert_eq!(jobs_list_all().unwrap().len(), usize_of!(JOB_COUNT_MAX));

        let past = job_id_from_text("past");

        meta_raw_write(&past, &serde_json::to_vec(&meta_with(&past, 1)).unwrap());

        assert!(jobs_list_all().unwrap_err().to_string().contains("4096"));
    }

    #[test]
    fn a_new_job_past_the_limit_is_refused_and_leaves_no_folder_while_listed_jobs_still_save() {
        let _root = root_scoped();
        let ids = jobs_filled(JOB_COUNT_MAX);
        let extra = job_id_from_text("extra");
        let refused = meta_save(&meta_with(&extra, 1)).unwrap_err().to_string();

        assert!(refused.contains("4096"), "{refused}");
        assert!(!jobs_directory().unwrap().join(&extra).exists());
        assert!(meta_load(&extra).unwrap().is_none());

        meta_save(&meta_with(&ids[0], 2)).unwrap();
        job_delete(&ids[1]).unwrap();
        meta_save(&meta_with(&extra, 1)).unwrap();

        assert_eq!(jobs_list_all().unwrap().len(), usize_of!(JOB_COUNT_MAX));
        assert_eq!(meta_load(&ids[0]).unwrap().unwrap().created_at_unix, 2);
    }

    #[test]
    fn new_jobs_racing_for_the_last_place_under_the_limit_admit_exactly_one() {
        let _root = root_scoped();
        let root_inherited = root_override();

        let racers: [String; 8] =
            std::array::from_fn(|index| job_id_from_text(&format!("racer-{index}")));

        drop(jobs_filled(JOB_COUNT_MAX - 1));

        let admitted = thread::scope(|scope| {
            let handles = racers.each_ref().map(|id| {
                let root_racer = root_inherited.clone();

                scope.spawn(move || {
                    root_adopt(root_racer);

                    meta_save(&meta_with(id, 1)).is_ok()
                })
            });

            handles.into_iter().map(|handle| handle.join().unwrap()).filter(|saved| *saved).count()
        });

        assert_eq!(admitted, 1);
        assert_eq!(jobs_list_all().unwrap().len(), usize_of!(JOB_COUNT_MAX));
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

    #[test]
    fn every_write_to_a_deleted_recording_is_refused_by_name_and_leaves_no_folder() {
        let _root = root_scoped();
        let id = job_id_from_text("deleted-write");
        let directory = jobs_directory().unwrap().join(&id);
        let slot = TranscriptSlot { engine_id: "remote-a", job_id: &id };
        let deleted = format!("recording {id} was deleted");

        meta_save(&meta_with(&id, 1)).unwrap();
        transcript_save(&slot, &transcript_with("before")).unwrap();
        job_delete(&id).unwrap();

        let refusals = [
            transcript_save(&slot, &transcript_with("late")),
            transcript_save_edited(&id, &transcript_with("edited")),
            notes_save(&id, b"late notes"),
            job_audio_save_streamed(&id, 8000, |writer| pcm16_append(writer, &[0.25_f32])),
            job_audio_clips_remove(&id),
            job_file_write(&id, &directory.join("print.html"), b"<!doctype html>"),
        ];

        for refused in refusals {
            let message = refused.unwrap_err().to_string();

            assert!(message.contains(&deleted), "{message}");
        }

        assert!(!directory.exists());
        assert!(jobs_list_all().unwrap().is_empty());
    }

    #[test]
    fn reading_a_deleted_recording_finds_nothing_and_leaves_no_folder() {
        let _root = root_scoped();
        let id = job_id_from_text("deleted-read");

        meta_save(&meta_with(&id, 1)).unwrap();
        notes_save(&id, b"notes").unwrap();
        job_delete(&id).unwrap();

        let slot = TranscriptSlot { engine_id: "remote-a", job_id: &id };

        assert!(notes_load(&id).unwrap().is_none());
        assert_eq!(engines_for_job(&id).unwrap().len(), 0);
        assert!(transcript_load::<Transcript>(&slot).unwrap().is_none());
        assert!(meta_load(&id).unwrap().is_none());
        assert!(job_files_load(&id).unwrap().is_none());
        assert!(!job_audio_path(&id).unwrap().exists());
        assert!(!jobs_directory().unwrap().join(&id).exists());
    }

    #[test]
    fn a_patch_after_its_recording_was_deleted_is_refused_by_name_and_leaves_no_folder() {
        let _root = root_scoped();
        let id = job_id_from_text("deleted-patch");
        let patch = JobMetaPatch { favourite: Some(true), ..JobMetaPatch::empty() };

        meta_save(&meta_with(&id, 1)).unwrap();
        job_delete(&id).unwrap();

        let refused = meta_apply_patch(&id, patch).unwrap_err().to_string();

        assert!(refused.contains(&format!("recording {id} was deleted")), "{refused}");
        assert!(!jobs_directory().unwrap().join(&id).exists());
        assert!(jobs_list_all().unwrap().is_empty());
    }

    #[test]
    fn a_delete_racing_patches_never_leaves_the_recording_listed() {
        let _root = root_scoped();
        let root_inherited = root_override();
        let id = job_id_from_text("raced");
        let favourite = JobMetaPatch { favourite: Some(true), ..JobMetaPatch::empty() };

        for round in 0_u32..24 {
            meta_save(&meta_with(&id, 1)).unwrap();

            thread::scope(|scope| {
                for _patcher in 0_u8..4 {
                    let root_patcher = root_inherited.clone();

                    let _handle = scope.spawn(|| {
                        root_adopt(root_patcher);

                        for _patch in 0_u8..64 {
                            if let Err(error) = meta_apply_patch(&id, favourite.clone()) {
                                assert!(error.to_string().contains("was deleted"), "{error}");

                                break;
                            }
                        }
                    });
                }

                let root_deleter = root_inherited.clone();

                let _handle = scope.spawn(|| {
                    root_adopt(root_deleter);
                    job_delete(&id).unwrap();
                });
            });

            assert!(jobs_list_all().unwrap().is_empty(), "round {round}");
            assert!(!jobs_directory().unwrap().join(&id).exists(), "round {round}");
        }
    }

    #[test]
    fn patches_to_different_fields_at_the_same_time_all_land() {
        let _root = root_scoped();
        let root_inherited = root_override();
        let id = job_id_from_text("patched-at-once");

        for round in 0_u32..24 {
            let title = format!("Title {round}");
            let attendees = vec![format!("Attendee {round}")];
            let person_ids = vec![format!("person {round}")];
            let named = vec![format!("named {round}")];
            let project = format!("Project {round}");
            let tags = vec![format!("tag {round}")];

            let patches = [
                JobMetaPatch { title: Some(title.clone()), ..JobMetaPatch::empty() },
                JobMetaPatch { attendees: Some(attendees.clone()), ..JobMetaPatch::empty() },
                JobMetaPatch { person_ids: Some(person_ids.clone()), ..JobMetaPatch::empty() },
                JobMetaPatch { person_ids_mentioned: Some(named.clone()), ..JobMetaPatch::empty() },
                JobMetaPatch { project: Some(project.clone()), ..JobMetaPatch::empty() },
                JobMetaPatch { tags: Some(tags.clone()), ..JobMetaPatch::empty() },
                JobMetaPatch { favourite: Some(true), ..JobMetaPatch::empty() },
            ];

            meta_save(&meta_with(&id, 1)).unwrap();

            thread::scope(|scope| {
                for patch in patches {
                    let root_patcher = root_inherited.clone();

                    let _handle = scope.spawn(|| {
                        root_adopt(root_patcher);

                        assert_eq!(meta_apply_patch(&id, patch).unwrap().id, id);
                    });
                }
            });

            let meta = meta_load(&id).unwrap().unwrap();

            assert_eq!(meta.title, Some(title));
            assert_eq!(meta.attendees, attendees);
            assert_eq!(meta.person_ids, person_ids);
            assert_eq!(meta.person_ids_mentioned, named);
            assert_eq!(meta.project, Some(project));
            assert_eq!(meta.tags, tags);
            assert!(meta.favourite);
        }
    }

    #[test]
    fn a_recording_created_over_a_folder_left_without_metadata_starts_empty() {
        let _root = root_scoped();
        let id = job_id_from_text("stray");
        let directory = jobs_directory().unwrap().join(&id);
        let leftover = serde_json::to_vec(&transcript_with("saved after the delete")).unwrap();

        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("transcript-remote-a.json"), leftover).unwrap();
        fs::write(directory.join(NOTES_FILE_NAME), b"notes saved after the delete").unwrap();

        meta_save(&meta_with(&id, 1)).unwrap();

        assert_eq!(engines_for_job(&id).unwrap().len(), 0);
        assert!(notes_load(&id).unwrap().is_none());
        assert_eq!(fs::read_dir(&directory).unwrap().count(), 1);
    }

    #[test]
    fn metadata_past_its_size_gate_is_refused_and_the_recording_still_loads() {
        let _root = root_scoped();
        let id = job_id_from_text("oversized-patch");
        let title = "a".repeat(usize_of!(META_BYTES_MAX));
        let patch = JobMetaPatch { title: Some(title.clone()), ..JobMetaPatch::empty() };
        let mut created = meta_with(&job_id_from_text("oversized-new"), 1);

        created.title = Some(title);
        meta_save(&meta_with(&id, 1)).unwrap();

        let refused = meta_apply_patch(&id, patch).unwrap_err().to_string();

        assert!(refused.contains("65536"), "{refused}");
        assert!(meta_load(&id).unwrap().unwrap().title.is_none());
        assert!(meta_save(&created).unwrap_err().to_string().contains("65536"));
        assert!(!jobs_directory().unwrap().join(&created.id).exists());
        assert_eq!(jobs_list_all().unwrap().len(), 1);
    }

    #[test]
    fn a_recording_deleted_while_its_audio_is_written_stays_deleted() {
        let _root = root_scoped();
        let id = job_id_from_text("deleted-mid-write");

        meta_save(&meta_with(&id, 1)).unwrap();

        let refused = job_audio_save_streamed(&id, 8000, |writer| {
            job_delete(&id)?;

            pcm16_append(writer, &[0.25_f32; 800])
        })
        .unwrap_err()
        .to_string();

        assert!(refused.contains(&format!("recording {id} was deleted")), "{refused}");
        assert!(!jobs_directory().unwrap().join(&id).exists());
        assert!(jobs_list_all().unwrap().is_empty());
    }

    #[test]
    fn a_transcript_past_its_size_gate_is_refused_before_it_is_written() {
        let _root = root_scoped();
        let id = job_id_from_text("oversized-transcript");
        let slot = TranscriptSlot { engine_id: "remote-a", job_id: &id };
        let oversized = transcript_with(&"a".repeat(usize_of!(TRANSCRIPT_BYTES_MAX).div_ceil(2)));

        meta_save(&meta_with(&id, 1)).unwrap();

        let refused = transcript_save(&slot, &oversized).unwrap_err().to_string();

        assert!(refused.contains(&TRANSCRIPT_BYTES_MAX.to_string()), "{refused}");
        assert!(transcript_load::<Transcript>(&slot).unwrap().is_none());
        assert_eq!(engines_for_job(&id).unwrap().len(), 0);
    }

    #[test]
    fn reading_a_recording_while_it_is_deleted_never_fails() {
        let _root = root_scoped();
        let root_inherited = root_override();
        let id = job_id_from_text("read-while-deleted");
        let slot = TranscriptSlot { engine_id: "remote-a", job_id: &id };

        for round in 0_u32..24 {
            meta_save(&meta_with(&id, 1)).unwrap();
            notes_save(&id, b"notes").unwrap();
            transcript_save(&slot, &transcript_with("words")).unwrap();

            thread::scope(|scope| {
                let root_reader = root_inherited.clone();
                let root_deleter = root_inherited.clone();

                let _reader = scope.spawn(|| {
                    root_adopt(root_reader);

                    for _read in 0_u16..1024 {
                        let loaded = job_files_load(&id);

                        assert!(loaded.is_ok(), "round {round}: {loaded:?}");

                        if loaded.is_ok_and(|files| files.is_none()) {
                            break;
                        }
                    }
                });

                let _deleter = scope.spawn(|| {
                    root_adopt(root_deleter);
                    job_delete(&id).unwrap();
                });
            });

            assert!(!jobs_directory().unwrap().join(&id).exists());
        }
    }

    #[test]
    fn a_clip_holds_the_samples_of_its_span_and_replaces_the_last_clip() {
        let _root = root_scoped();
        let id = job_id_from_text("clipped");
        let source = job_audio_path(&id).unwrap();
        let samples: Vec<f32> = (0_u16..8000).map(|index| f32::from(index % 200) / 400.0).collect();
        let earlier = ClipSpan::of(ClipStart(0.0), ClipEnd(0.125)).unwrap();
        let span = ClipSpan::of(ClipStart(0.25), ClipEnd(0.5)).unwrap();
        let clip_earlier = job_audio_clip_path(&id, earlier).unwrap();
        let clip = job_audio_clip_path(&id, span).unwrap();

        meta_save(&meta_with(&id, 1)).unwrap();
        audio_wav_save(&samples, 8000, &source).unwrap();
        audio_clip_save(&id, &ClipPaths { clip: &clip_earlier, source: &source }, earlier).unwrap();
        job_audio_clips_remove(&id).unwrap();
        audio_clip_save(&id, &ClipPaths { clip: &clip, source: &source }, span).unwrap();

        let (clipped, sample_rate) = audio_wav_load(&clip).unwrap();
        let (whole, _whole_rate) = audio_wav_load(&source).unwrap();

        assert_eq!(sample_rate, 8000);
        assert_eq!(clipped, whole[2000..4000]);
        assert!(!clip_earlier.exists());
        assert_eq!(fs::read_dir(clip.parent().unwrap()).unwrap().count(), 3);
    }
}
