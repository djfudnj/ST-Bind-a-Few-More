# Bind a Few More

A SillyTavern extension that binds settings to each character or group. Open a chat and **the bound theme, preset, model, background, Quick Reply sets, and custom CSS** are applied automatically.

Everything is managed from the extension panel, or from the shortcut icon next to the ★ (favorite) button in the character / group editor.

<br>

## What You Can Bind

Each item is optional. Leave it on **(No change)** and it won't be touched.

### 1. UI Theme
Switches to the chosen theme when the chat opens.

### 2. Chat Completion Preset
Switches to the chosen preset. Works only when the current API is Chat Completion.

### 3. Chat Completion Source & Model
Pick a source from SillyTavern's own list, then type the model name yourself. Any model ID works, even ones that aren't in the dropdown.

- Applied right after the preset, in this order: **preset → source → model**.
- Leave the source on **(No change)** to apply the model to whichever source is active.
- When the source or model actually changes, a toast tells you where your chat is now going.
- Works only when the current API is Chat Completion.

### 4. Background
Binds a background to the chat using SillyTavern's own **Lock**, so it stays in sync with the Backgrounds panel (locking, unlocking, or picking another background while locked updates the binding too).

- Pick from a searchable thumbnail gallery, or enter an image URL directly (the URL takes priority).
- Adjust thumbnail size with the slider.
- **Preload backgrounds** keeps up to 10 recent bound images in memory for faster switching. Off by default, uses extra memory.

### 5. Quick Reply Sets
- **Characters:** checked sets are applied directly to SillyTavern's Character Quick Reply Set.
- **Groups:** groups have no Character QR sets, so checked sets are linked to the chat whenever you open a chat in that group.

### 6. Additional Custom CSS
Add as many CSS snippets as you like. Each has its own name, on/off switch, rename, and delete. Applied after the theme's Custom CSS, so yours wins when selectors match.

