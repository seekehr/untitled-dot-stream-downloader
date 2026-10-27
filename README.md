# untitled.stream downloader

Download entire projects from untitled.stream or selected tracks in parallel without the ZIP size limit. Keeps original audio quality, cover art, and metadata, uses your existing Chrome login, and saves songs by title to a configurable folder.

## Setup

1. Install Node.js 24+ and Google Chrome 144+.
2. Run `npm install`.
3. Copy `config.example.json` to `config.json`. Set `output` (e.g. `~/Music/{projectName}`) and `concurrency` (default: 6, maximum: 16).
4. In your regular Chrome, sign in to untitled.stream and enable `chrome://inspect/#remote-debugging`.
5. Run `npm start` and approve Chrome's connection prompt.
6. Enter the optional invite URL, then the project URL. If invited, accept it in Chrome and press Enter in the terminal.

For selected tracks, run `npm start -- --track 1 --track 3`. Use `npm start -- --list` to see track numbers.
