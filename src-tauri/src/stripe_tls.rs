#[cfg(target_os = "linux")]
pub(crate) use linux::api_certificate_allow;

#[cfg(not(target_os = "linux"))]
pub(crate) fn api_certificate_allow(
    window: &tauri::WebviewWindow,
) -> std::future::Ready<crate::error::AppResult<()>> {
    assert_ne!(window.label(), "");

    std::future::ready(Ok(()))
}

#[cfg(target_os = "linux")]
mod linux {
    use crate::error::{AppError, AppResult};
    use crate::http::{ClientCell, client_get, crypto_provider_install};
    use std::sync::LazyLock;
    use std::time::Duration;
    use tauri::WebviewWindow;
    use tokio::sync::oneshot;
    use webkit2gtk::gio::TlsCertificate;
    use webkit2gtk::glib::base64_encode;
    use webkit2gtk::{WebContextExt, WebViewExt};

    const CERTIFICATE_BYTES_MAX: u32 = 16_384;
    const CONNECT_TIMEOUT_SECONDS: u64 = 10;
    const PEM_FOOTER: &str = "-----END CERTIFICATE-----\n";
    const PEM_HEADER: &str = "-----BEGIN CERTIFICATE-----\n";
    const PEM_LINE_CHARS: usize = 64;
    const REQUEST_TIMEOUT_SECONDS: u64 = 20;
    const STRIPE_API_HOST: &str = "api.stripe.com";
    const STRIPE_API_URL: &str = "https://api.stripe.com/";

    const _: () = assert!(CONNECT_TIMEOUT_SECONDS < REQUEST_TIMEOUT_SECONDS);

    static HTTP_CLIENT: ClientCell = LazyLock::new(client_build);

    pub(crate) async fn api_certificate_allow(window: &WebviewWindow) -> AppResult<()> {
        let certificate = api_certificate_fetch().await?;
        let installed = certificate_send(window, &certificate)?;

        installed.await.map_err(|_closed| {
            AppError::Config("the webview closed before it took Stripe's certificate".into())
        })?
    }

    async fn api_certificate_fetch() -> AppResult<Vec<u8>> {
        let client = client_get(&HTTP_CLIENT)?;
        let response = client.head(STRIPE_API_URL).send().await?;

        assert_eq!(response.url().scheme(), "https");
        assert_eq!(response.url().host_str(), Some(STRIPE_API_HOST));

        let certificate = response
            .extensions()
            .get::<reqwest::tls::TlsInfo>()
            .and_then(reqwest::tls::TlsInfo::peer_certificate)
            .map(<[u8]>::to_vec)
            .unwrap_or_default();

        if certificate.is_empty() {
            return Err(AppError::Service("Stripe's API presented no certificate".into()));
        }

        if certificate.len() > usize_of!(CERTIFICATE_BYTES_MAX) {
            return Err(AppError::Service(format!(
                "Stripe's API presented a certificate of {} bytes",
                certificate.len(),
            )));
        }

        Ok(certificate)
    }

    fn certificate_install(webview: &webkit2gtk::WebView, pem: &str) -> AppResult<()> {
        assert!(pem.starts_with(PEM_HEADER));
        assert!(pem.ends_with(PEM_FOOTER));

        let context = webview
            .context()
            .ok_or_else(|| AppError::Config("the webview has no web context".into()))?;

        let certificate = TlsCertificate::from_pem(pem).map_err(|error| {
            AppError::Config(format!("Stripe's certificate could not be read: {error}"))
        })?;

        context.allow_tls_certificate_for_host(&certificate, STRIPE_API_HOST);

        Ok(())
    }

    fn certificate_pem(der: &[u8]) -> AppResult<String> {
        assert_ne!(der.len(), 0);
        assert!(der.len() <= usize_of!(CERTIFICATE_BYTES_MAX));

        let encoded = base64_encode(der);
        let lines = encoded.len().div_ceil(PEM_LINE_CHARS);
        let capacity = PEM_HEADER.len() + encoded.len() + lines + PEM_FOOTER.len();
        let mut pem = String::with_capacity(capacity);

        pem.push_str(PEM_HEADER);

        for line in encoded.as_bytes().chunks(PEM_LINE_CHARS) {
            let text = std::str::from_utf8(line).map_err(|error| {
                AppError::Config(format!("the certificate encoding is not ASCII: {error}"))
            })?;

            pem.push_str(text);
            pem.push('\n');
        }

        pem.push_str(PEM_FOOTER);

        assert!(pem.ends_with(PEM_FOOTER));

        Ok(pem)
    }

    fn certificate_send(
        window: &WebviewWindow,
        certificate: &[u8],
    ) -> AppResult<oneshot::Receiver<AppResult<()>>> {
        assert_ne!(certificate.len(), 0);

        let pem = certificate_pem(certificate)?;
        let (installed_sender, installed_receiver) = oneshot::channel();

        assert!(pem.starts_with(PEM_HEADER));
        assert!(pem.len() > certificate.len());

        window
            .with_webview(move |webview| {
                let _sent = installed_sender.send(certificate_install(&webview.inner(), &pem));
            })
            .map_err(|error| {
                AppError::Config(format!("the webview could not be reached: {error}"))
            })?;

        Ok(installed_receiver)
    }

    fn client_build() -> Result<reqwest::Client, String> {
        crypto_provider_install();

        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECONDS))
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECONDS))
            .redirect(reqwest::redirect::Policy::none())
            .tls_info(true)
            .build()
            .map_err(|error| format!("the Stripe certificate client could not be built: {error}"))
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use webkit2gtk::gio::prelude::TlsCertificateExt;
        use webkit2gtk::glib::base64_decode;

        const ROOT_PEM: &str = concat!(
            "-----BEGIN CERTIFICATE-----\n",
            "MIIFazCCA1OgAwIBAgIRAIIQz7DSQONZRGPgu2OCiwAwDQYJKoZIhvcNAQELBQAw\n",
            "TzELMAkGA1UEBhMCVVMxKTAnBgNVBAoTIEludGVybmV0IFNlY3VyaXR5IFJlc2Vh\n",
            "cmNoIEdyb3VwMRUwEwYDVQQDEwxJU1JHIFJvb3QgWDEwHhcNMTUwNjA0MTEwNDM4\n",
            "WhcNMzUwNjA0MTEwNDM4WjBPMQswCQYDVQQGEwJVUzEpMCcGA1UEChMgSW50ZXJu\n",
            "ZXQgU2VjdXJpdHkgUmVzZWFyY2ggR3JvdXAxFTATBgNVBAMTDElTUkcgUm9vdCBY\n",
            "MTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAK3oJHP0FDfzm54rVygc\n",
            "h77ct984kIxuPOZXoHj3dcKi/vVqbvYATyjb3miGbESTtrFj/RQSa78f0uoxmyF+\n",
            "0TM8ukj13Xnfs7j/EvEhmkvBioZxaUpmZmyPfjxwv60pIgbz5MDmgK7iS4+3mX6U\n",
            "A5/TR5d8mUgjU+g4rk8Kb4Mu0UlXjIB0ttov0DiNewNwIRt18jA8+o+u3dpjq+sW\n",
            "T8KOEUt+zwvo/7V3LvSye0rgTBIlDHCNAymg4VMk7BPZ7hm/ELNKjD+Jo2FR3qyH\n",
            "B5T0Y3HsLuJvW5iB4YlcNHlsdu87kGJ55tukmi8mxdAQ4Q7e2RCOFvu396j3x+UC\n",
            "B5iPNgiV5+I3lg02dZ77DnKxHZu8A/lJBdiB3QW0KtZB6awBdpUKD9jf1b0SHzUv\n",
            "KBds0pjBqAlkd25HN7rOrFleaJ1/ctaJxQZBKT5ZPt0m9STJEadao0xAH0ahmbWn\n",
            "OlFuhjuefXKnEgV4We0+UXgVCwOPjdAvBbI+e0ocS3MFEvzG6uBQE3xDk3SzynTn\n",
            "jh8BCNAw1FtxNrQHusEwMFxIt4I7mKZ9YIqioymCzLq9gwQbooMDQaHWBfEbwrbw\n",
            "qHyGO0aoSCqI3Haadr8faqU9GY/rOPNk3sgrDQoo//fb4hVC1CLQJ13hef4Y53CI\n",
            "rU7m2Ys6xt0nUW7/vGT1M0NPAgMBAAGjQjBAMA4GA1UdDwEB/wQEAwIBBjAPBgNV\n",
            "HRMBAf8EBTADAQH/MB0GA1UdDgQWBBR5tFnme7bl5AFzgAiIyBpY9umbbjANBgkq\n",
            "hkiG9w0BAQsFAAOCAgEAVR9YqbyyqFDQDLHYGmkgJykIrGF1XIpu+ILlaS/V9lZL\n",
            "ubhzEFnTIZd+50xx+7LSYK05qAvqFyFWhfFQDlnrzuBZ6brJFe+GnY+EgPbk6ZGQ\n",
            "3BebYhtF8GaV0nxvwuo77x/Py9auJ/GpsMiu/X1+mvoiBOv/2X/qkSsisRcOj/KK\n",
            "NFtY2PwByVS5uCbMiogziUwthDyC3+6WVwW6LLv3xLfHTjuCvjHIInNzktHCgKQ5\n",
            "ORAzI4JMPJ+GslWYHb4phowim57iaztXOoJwTdwJx4nLCgdNbOhdjsnvzqvHu7Ur\n",
            "TkXWStAmzOVyyghqpZXjFaH3pO3JLF+l+/+sKAIuvtd7u+Nxe5AW0wdeRlN8NwdC\n",
            "jNPElpzVmbUq4JUagEiuTDkHzsxHpFKVK7q4+63SM1N95R1NbdWhscdCb+ZAJzVc\n",
            "oyi3B43njTOQ5yOf+1CceWxG1bQVs5ZufpsMljq4Ui0/1lvh+wjChP4kqKOJ2qxq\n",
            "4RgqsahDYVvTH9w7jXbyLeiNdd8XM2w9U/t7y0Ff/9yi0GE44Za4rF2LN9d11TPA\n",
            "mRGunUHBcnWEvgJBQl9nJEiU0Zsnvgc/ubhPgXRR4Xq37Z0j4r7g1SgEEzwxA57d\n",
            "emyPxgcYxn/eR44/KJ4EBs+lVDR3veyJm+kXQ99b21/+jh5Xos1AnX5iItreGCc=\n",
            "-----END CERTIFICATE-----\n",
        );

        fn pem_body(pem: &str) -> String {
            assert!(pem.starts_with(PEM_HEADER));
            assert!(pem.ends_with(PEM_FOOTER));

            pem.lines().filter(|line| !line.starts_with("-----")).collect()
        }

        #[test]
        fn a_certificate_is_armoured_in_short_lines_that_decode_back_to_its_bytes() {
            let der: Vec<u8> = (0_u8..=255).cycle().take(1000).collect();
            let pem = certificate_pem(&der).unwrap();
            let lines: Vec<&str> = pem.lines().collect();

            assert_eq!(lines.len(), 23);
            assert_eq!(lines.first().copied(), Some(PEM_HEADER.trim_end()));
            assert_eq!(lines.last().copied(), Some(PEM_FOOTER.trim_end()));
            assert!(lines.iter().all(|line| line.len() <= PEM_LINE_CHARS));
            assert_eq!(base64_decode(&pem_body(&pem)), der);
        }

        #[test]
        fn a_real_certificate_reads_back_through_gio_as_the_same_certificate() {
            let der = base64_decode(&pem_body(ROOT_PEM));
            let pem = certificate_pem(&der).unwrap();
            let original = TlsCertificate::from_pem(ROOT_PEM).unwrap();
            let rebuilt = TlsCertificate::from_pem(&pem).unwrap();

            assert_eq!(pem, ROOT_PEM);
            assert!(rebuilt.is_same(&original));
        }
    }
}
