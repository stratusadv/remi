use crate::error::{AppError, AppResult};
use docmux::html::HTMLRaw;
use docmux::markdown::Options;
use docmux::{Document, Workspace, docx, html, markdown};
use std::thread;

const CONVERTER_THREAD_NAME: &str = "scribe-converter";
const DOCX_MAGIC: &[u8] = b"PK\x03\x04";
const MARKDOWN_BYTES_MAX: usize = OUTPUT_BYTES_MAX >> 2;
const OUTPUT_BYTES_MAX: usize = 16 << 20;
const STACK_FACTOR: u8 = 3;

const _: () = assert!(MARKDOWN_BYTES_MAX < OUTPUT_BYTES_MAX);

struct Conversion {
    document: Box<Document>,
    output: Vec<u8>,
    workspace: Box<Workspace>,
}

pub(crate) fn markdown_to_docx(markdown: &str) -> AppResult<Vec<u8>> {
    conversion_run(markdown, |conversion| {
        let Conversion { document, output, workspace } = conversion;
        let length = docx::write(document, workspace, output).map_err(convert_error)?;
        let end = usize::try_from(length).map_err(|error| AppError::Export(error.to_string()))?;
        let written = output.get(..end).ok_or_else(output_overflow)?;

        assert_eq!(written.len(), end);
        assert!(written.starts_with(DOCX_MAGIC));

        Ok(written.to_vec())
    })
}

pub(crate) fn markdown_to_html(markdown: &str) -> AppResult<String> {
    let written = conversion_run(markdown, |conversion| {
        let length = html::write(&conversion.document, HTMLRaw::Escape, &mut conversion.output)
            .map_err(convert_error)?;

        let end = usize::try_from(length).map_err(|error| AppError::Export(error.to_string()))?;
        let written = conversion.output.get(..end).ok_or_else(output_overflow)?.to_vec();

        assert_eq!(written.len(), end);

        Ok(written)
    })?;

    let length = written.len();
    let html = output_string(written)?;

    assert_eq!(html.len(), length);

    Ok(html)
}

fn conversion_begin(markdown: &str) -> AppResult<Conversion> {
    assert!(markdown.len() <= MARKDOWN_BYTES_MAX);

    let mut conversion = Conversion {
        document: Box::new(Document::EMPTY),
        output: vec![0; OUTPUT_BYTES_MAX],
        workspace: Box::new(Workspace::EMPTY),
    };

    let Conversion { document, workspace, .. } = &mut conversion;

    markdown::read(markdown.as_bytes(), Options::GFM, workspace, document)
        .map_err(convert_error)?;

    assert!(conversion.document.node_count() >= 1);
    assert_eq!(conversion.output.len(), OUTPUT_BYTES_MAX);

    Ok(conversion)
}

fn conversion_run<Reply, Work>(markdown: &str, work: Work) -> AppResult<Reply>
where
    Reply: Send,
    Work: FnOnce(&mut Conversion) -> AppResult<Reply> + Send,
{
    if markdown.len() > MARKDOWN_BYTES_MAX {
        return Err(AppError::Export(format!(
            "these notes are {} MB, over the {} MB this app can convert",
            markdown.len() >> 20,
            MARKDOWN_BYTES_MAX >> 20,
        )));
    }

    let stack_bytes = size_of::<Document>()
        .saturating_add(size_of::<Workspace>())
        .saturating_mul(usize::from(STACK_FACTOR));

    let builder =
        thread::Builder::new().name(CONVERTER_THREAD_NAME.to_owned()).stack_size(stack_bytes);

    thread::scope(|scope| {
        let converter = builder
            .spawn_scoped(scope, || work(&mut conversion_begin(markdown)?))
            .map_err(|error| AppError::Export(format!("could not start the converter: {error}")))?;

        converter
            .join()
            .map_err(|_panic| AppError::Export("the converter stopped unexpectedly".into()))?
    })
}

fn convert_error(error: docmux::Error) -> AppError {
    AppError::Export(error.to_string())
}

fn output_overflow() -> AppError {
    AppError::Export("converter reported a length past the output buffer".into())
}

fn output_string(output: Vec<u8>) -> AppResult<String> {
    assert!(output.len() <= OUTPUT_BYTES_MAX);

    let length = output.len();

    let text = String::from_utf8(output)
        .map_err(|error| AppError::Export(format!("converter produced invalid UTF-8: {error}")))?;

    assert_eq!(text.len(), length);

    Ok(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = concat!(
        "# Title\n\nSome **bold** text and a [link](https://example.com).\n\n",
        "- [x] done\n- [ ] todo\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n",
    );

    #[test]
    fn html_escapes_raw_markup() {
        let html = markdown_to_html("<script>alert(1)</script>\n\n**b**\n").unwrap();

        assert!(html.contains("&lt;script&gt;"));
        assert!(html.contains("<strong>b</strong>"));
    }

    #[test]
    fn docx_is_zip_package() {
        let bytes = markdown_to_docx(SAMPLE).unwrap();

        assert!(bytes.starts_with(DOCX_MAGIC));
        assert!(bytes.len() > 10_000);
        assert!(bytes.len() <= OUTPUT_BYTES_MAX);
    }

    #[test]
    fn markdown_past_the_buffer_limit_is_an_error_not_a_crash() {
        let oversized = "a".repeat(MARKDOWN_BYTES_MAX + 1);

        assert_ne!(markdown_to_html(&oversized).unwrap_err().to_string(), "");
        assert_ne!(markdown_to_docx(&oversized).unwrap_err().to_string(), "");
    }
}
