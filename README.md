![RephraseThis animated demo](assets/rephrasethis-hero-animated.gif)

# RephraseThis

RephraseThis helps you polish selected text in Obsidian without leaving the
editor. Select a passage, choose **Rephrase selection** or the inline
**rephrase** button, then accept a suggestion to replace the selected text in
place.

## Features

- Rephrase selected text directly in the editor.
- Review suggestions before anything is written back to your note.
- Cycle through alternate suggestions with the keyboard.
- Use Ollama, OpenAI, OpenRouter, or another OpenAI-compatible chat API.
- Store API keys with Obsidian Secret Storage.
- Tune how much nearby writing is included for style and context.

## Network and privacy

RephraseThis only sends note content when you explicitly run a rephrase action.
The request includes the selected text and, depending on your writing-context
setting, nearby text before and after the selection.

- Destination: the API base URL configured in **Settings > RephraseThis**.
- Purpose: generate the requested rephrase suggestions.
- Authentication: optional user-provided API key, stored with Obsidian Secret
  Storage.
- Telemetry: none.
- Ads: none.
- Background rephrasing: none.
- Files outside the vault: none.

Provider-specific network requests:

- Ollama: requests are sent to the configured Ollama-compatible endpoint. The
  default is `http://localhost:11434/v1`.
- Ollama model discovery: when the Ollama preset is selected, the plugin can
  request local model lists and recent Ollama cloud model metadata so the model
  dropdown is easier to use.
- OpenAI: requests are sent to `https://api.openai.com/v1` unless you change
  the API base URL.
- OpenRouter: requests are sent to `https://openrouter.ai/api/v1`; the plugin
  can also request OpenRouter's public model catalog.
- Custom providers: requests are sent to the custom API base URL you enter.

Your configured provider may have its own data retention, privacy, account, and
billing rules. Review the provider's policies before sending sensitive notes to
it.

## API setup

The default provider is Ollama with the model `nemotron-3-super:cloud`.

For the default Ollama setup:

- Install Ollama.
- Sign in if Ollama Cloud asks for it: `ollama signin`.
- Pull the default model if you do not already have it:
  `ollama pull nemotron-3-super:cloud`.
- Confirm Ollama can see the model through the OpenAI-compatible API:
  `curl http://localhost:11434/v1/models`.
- In Obsidian, open **Settings > RephraseThis** and select **Test connection**.

To keep inference on your own machine, choose a local Ollama model in
**Settings > RephraseThis** instead of the default cloud model.

For OpenAI, OpenRouter, or another compatible provider, choose the provider or
custom base URL, enter an API key if required, and choose a model. API keys are
stored with Obsidian Secret Storage; RephraseThis saves only an internal secret
name in plugin data.

## Usage

- Select text in a note.
- Select the small **rephrase** button above the selection, or run
  **Rephrase selection** from the command palette.
- Press **Tab** to cycle through suggestions once they appear.
- Press **Enter** to replace the selected text with the current suggestion.
- Press **Esc** to cancel without changing the note.

You can assign your own shortcut from **Settings > RephraseThis**:

- Select **Open hotkeys** in the **Rephrase behavior** section.
- Search for **Rephrase selection** if it is not filled automatically.
- Press **+** next to the command, choose your shortcut, then save it.

## Manual installation

- Download `main.js`, `styles.css`, and `manifest.json` from a GitHub release.
- Copy them into `VaultFolder/.obsidian/plugins/rephrasethis/`.
- Reload Obsidian.
- Enable **RephraseThis** under **Settings > Community plugins**.

## Development

Requirements:

- Node.js 18 or newer.
- npm.

Commands:

```bash
npm install
npm run build
npm run lint
npm audit --audit-level=moderate
```

Watch while developing:

```bash
npm run dev
```

Install a fresh build into a local vault:

```bash
npm run install:vault -- "/path/to/your/vault"
```

The install command removes the existing local plugin folder, builds the plugin,
copies `main.js`, `manifest.json`, and `styles.css`, then verifies that the
copied files match the fresh build.

## Release checklist

- Run `npm ci`.
- Run `npm run lint`.
- Run `npm run build`.
- Confirm `manifest.json` and `versions.json` have the intended version.
- Publish a GitHub release whose tag exactly matches `manifest.json`'s version.
- Attach `main.js`, `manifest.json`, and `styles.css` as release assets.

## License

RephraseThis is released under the 0BSD license. See [LICENSE](LICENSE).
