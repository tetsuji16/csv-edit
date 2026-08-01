# Privacy

CSV Edit is a local-first Visual Studio Code extension.

## Data processing

- Document parsing, editing, search, filtering, transformation, and validation
  run locally inside the VS Code extension host and webview.
- CSV Edit does not upload document contents, usage data, diagnostics, or editor
  state to a service operated by this project.
- Per-file display preferences are stored through VS Code state APIs and are not
  written into the CSV document.

## User-initiated external actions

Links detected inside cells open only after an explicit user action and are
handled by VS Code's external URI mechanism. GitHub, Marketplace, documentation,
issue, and sponsorship links are opened only when selected by the user and are
then subject to the destination service's privacy policy.

## Support data

Support is handled through GitHub issues. Do not include personal information,
credentials, private URLs, or confidential document contents in reports or
attachments. See [SUPPORT.md](SUPPORT.md) for safe reporting guidance.
