use crate::error::{AppError, AppResult};
use std::fs;
use std::path::Path;

const SECRET_FILE_BYTES_MAX: u32 = 64 << 10;

#[cfg(windows)]
mod dpapi {
    use crate::error::{AppError, AppResult};
    use std::ptr;
    use windows_sys::Win32::Foundation::{GetLastError, LocalFree};
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB,
        CRYPTPROTECT_UI_FORBIDDEN,
        CryptProtectData,
        CryptUnprotectData,
    };

    fn blob_input(bytes: &[u8]) -> AppResult<CRYPT_INTEGER_BLOB> {
        let length = u32::try_from(bytes.len()).map_err(|_overflow| {
            AppError::Config("the secret is larger than DPAPI accepts".into())
        })?;

        assert_eq!(usize_of!(length), bytes.len());

        Ok(CRYPT_INTEGER_BLOB { cbData: length, pbData: bytes.as_ptr().cast_mut() })
    }

    fn blob_output_take(blob: &CRYPT_INTEGER_BLOB, call: &str) -> AppResult<Vec<u8>> {
        assert_ne!(call, "");

        if blob.pbData.is_null() {
            return Err(AppError::Config(format!("{call} returned no data")));
        }

        let length = usize_of!(blob.cbData);
        let bytes = unsafe { std::slice::from_raw_parts(blob.pbData, length).to_vec() };
        let freed = unsafe { LocalFree(blob.pbData.cast()) };

        if !freed.is_null() {
            tracing::warn!(
                target: "remi_lib::secrets",
                "the memory {call} returned could not be released",
            );
        }

        assert_eq!(bytes.len(), length);

        Ok(bytes)
    }

    fn error_last(call: &str) -> AppError {
        assert_ne!(call, "");

        let code = unsafe { GetLastError() };

        AppError::Config(format!("{call} failed (code {code})"))
    }

    pub(crate) fn protect(plaintext: &[u8]) -> AppResult<Vec<u8>> {
        assert_ne!(plaintext.len(), 0);

        let blob_plain = blob_input(plaintext)?;
        let mut blob_cipher = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };

        assert!(blob_cipher.pbData.is_null());

        let succeeded = unsafe {
            CryptProtectData(
                &raw const blob_plain,
                ptr::null(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &raw mut blob_cipher,
            )
        };

        if succeeded == 0_i32 {
            return Err(error_last("CryptProtectData"));
        }

        blob_output_take(&blob_cipher, "CryptProtectData")
    }

    pub(crate) fn unprotect(ciphertext: &[u8]) -> AppResult<Vec<u8>> {
        assert_ne!(ciphertext.len(), 0);

        let blob_cipher = blob_input(ciphertext)?;
        let mut blob_plain = CRYPT_INTEGER_BLOB { cbData: 0, pbData: ptr::null_mut() };

        assert!(blob_plain.pbData.is_null());

        let succeeded = unsafe {
            CryptUnprotectData(
                &raw const blob_cipher,
                ptr::null_mut(),
                ptr::null(),
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &raw mut blob_plain,
            )
        };

        if succeeded == 0_i32 {
            return Err(error_last("CryptUnprotectData"));
        }

        blob_output_take(&blob_plain, "CryptUnprotectData")
    }
}

pub(crate) fn protected_delete(path: &Path) -> AppResult<()> {
    assert!(path.file_name().is_some());

    if path.exists() {
        fs::remove_file(path)?;
    }

    Ok(())
}

pub(crate) fn protected_read(path: &Path) -> AppResult<Option<String>> {
    assert!(path.file_name().is_some());

    if !path.exists() {
        return Ok(None);
    }

    let size = fs::metadata(path)?.len();

    if size > u64::from(SECRET_FILE_BYTES_MAX) {
        return Err(AppError::Config(format!(
            "{} is {size} bytes, over the {SECRET_FILE_BYTES_MAX} bytes a secret store can hold",
            path.display(),
        )));
    }

    assert!(size <= u64::from(SECRET_FILE_BYTES_MAX));

    #[cfg(windows)]
    {
        let ciphertext = fs::read(path)?;

        if ciphertext.is_empty() {
            return Ok(None);
        }

        let plaintext_bytes = dpapi::unprotect(&ciphertext)?;

        let plaintext = String::from_utf8(plaintext_bytes)
            .map_err(|error| AppError::Config(format!("decrypted bytes are not utf-8: {error}")))?;

        Ok(Some(plaintext))
    }

    #[cfg(not(windows))]
    {
        Ok(Some(fs::read_to_string(path)?))
    }
}

pub(crate) fn protected_write(path: &Path, plaintext: &str) -> AppResult<()> {
    assert_ne!(plaintext, "");
    assert!(path.file_name().is_some());

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }

    #[cfg(windows)]
    {
        let ciphertext = dpapi::protect(plaintext.as_bytes())?;

        assert_ne!(ciphertext.as_slice(), plaintext.as_bytes());

        crate::workspace::atomic_write(path, &ciphertext)?;
    }

    #[cfg(not(windows))]
    {
        tracing::warn!(
            target: "remi_lib::secrets",
            "writing secret as plaintext to {} (DPAPI only available on Windows)",
            path.display(),
        );

        crate::workspace::atomic_write_private(path, plaintext.as_bytes())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::root;
    use crate::workspace::test_support::root_scoped;

    #[test]
    fn a_secret_survives_a_round_trip_and_is_gone_once_deleted() {
        let _root = root_scoped();
        let path = root().unwrap().join("nested").join("secret.bin");

        assert!(protected_read(&path).unwrap().is_none());

        protected_write(&path, "key").unwrap();

        assert_eq!(protected_read(&path).unwrap().as_deref(), Some("key"));

        protected_write(&path, "replaced").unwrap();

        assert_eq!(protected_read(&path).unwrap().as_deref(), Some("replaced"));

        protected_delete(&path).unwrap();
        protected_delete(&path).unwrap();

        assert!(protected_read(&path).unwrap().is_none());
        assert!(!path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn an_empty_secret_file_reads_as_no_secret() {
        let _root = root_scoped();
        let path = root().unwrap().join("secret.bin");

        fs::write(&path, b"").unwrap();

        assert!(protected_read(&path).unwrap().is_none());
    }

    #[cfg(not(windows))]
    fn mode_of(path: &Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;

        fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[cfg(not(windows))]
    #[test]
    fn a_written_secret_is_readable_by_its_owner_alone() {
        use std::os::unix::fs::PermissionsExt;

        let _root = root_scoped();
        let path = root().unwrap().join("secret.bin");

        protected_write(&path, "key").unwrap();

        assert_eq!(mode_of(&path), 0o600);

        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        protected_write(&path, "replaced").unwrap();

        assert_eq!(mode_of(&path), 0o600);
        assert_eq!(protected_read(&path).unwrap().as_deref(), Some("replaced"));
    }

    #[test]
    fn a_secret_file_past_its_size_gate_is_refused_rather_than_read() {
        let _root = root_scoped();
        let path = root().unwrap().join("secret.bin");
        let oversized = vec![b'x'; usize_of!(SECRET_FILE_BYTES_MAX) + 1];

        fs::write(&path, oversized).unwrap();

        let refused = protected_read(&path).unwrap_err().to_string();

        assert!(refused.contains("over the"));
        assert!(refused.contains("secret.bin"));
        assert!(path.exists());
        assert_ne!(SECRET_FILE_BYTES_MAX, 0);
    }
}
