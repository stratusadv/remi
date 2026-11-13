# Templates

## Overview

A template is the layout of a document, written in Markdown: the headings you want, with a note under each saying what goes there. The AI fills it in from the recording.

## Add A Template

1. Open *Templates* in the sidebar and press *Add template*.
2. Enter a name.
3. Press *Markdown* on the editor toolbar, then write or paste the layout.
4. Press *Save*.

The *AI* button on the toolbar drafts a layout from a description. The *Make default* item in a template's menu picks it for each new recording.

## Example

This template gives one page of decisions, actions, and open questions.

```markdown title="Meeting summary"
## Summary

Two or three sentences on what the meeting was about and where it ended up.

## Decisions

- Each decision that was made, one per bullet, written as a statement. Leave out anything that was only discussed.

## Action items

| Owner | Action | Due |
| --- | --- | --- |
| The person who took it on | What they agreed to do | The date, if one was said |

## Open questions

- [ ] **Person's name** the question they are following up on, and by when if a date was mentioned.
```

The AI keeps each heading and replaces each note with real content. It keeps a table's header row and writes one row for each item, and it writes one `- [ ]` item for each real checklist item. A section with nothing to report reads `Nothing recorded.`.

A role never appears next to a name, even where a template asks for one.
