# Fansly Data Monitor

This repository monitors changes to Fansly's main JavaScript file to track API changes, headers, and security mechanisms.

## Features

- Automatically downloads and archives Fansly's main JS file
- Extracts important security headers and check keys
- Uses Puppeteer to capture real API requests with actual headers
- Option to prettify JavaScript for easier reading
- Stores metadata about each version
- Runs on a schedule via GitHub Actions

## Repository Structure

- `/data/fansly-js` - Contains archived JavaScript files with timestamps and hashes
- `/data/metadata` - Contains metadata for each JS file version
  - `latest.json` - Information about the most recent version

## Setup

### Local Development

1. Clone this repository
2. Install dependencies:
   ```bash
   bun install
   ```
3. Run the monitor:
   ```bash
   bun run start
   ```

### Configuration

You can configure the monitor with environment variables:

- `PRETTIFY_JS` - Set to "true" to prettify the JavaScript files (default: false)
- `FANSLY_TOKEN` - Optional Fansly authentication token to capture authenticated requests

## GitHub Actions

The repository is configured to run the monitor every 12 hours via GitHub Actions. You can also trigger the workflow manually from the Actions tab.

## Security Note

This tool is for educational and research purposes only. All sensitive information like authorization tokens and cookies are automatically redacted.
