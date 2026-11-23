# Bind a Few More

A SillyTavern extension that binds a few settings to each character or group.




Everything is managed from the extension panel

<p align="center">
  <img width="514" height="730" alt="image" src="https://github.com/user-attachments/assets/eb0194de-2626-49c8-9484-6b795dbed61e" />
</p>


or from the shortcut icon next to the ★ (favorite) button in the character management.

<p align="center">
<img width="510" height="226" alt="image" src="https://github.com/user-attachments/assets/05c8c73e-89f1-4a5b-bf49-8054b299f126" />

<img width="587" height="413" alt="image" src="https://github.com/user-attachments/assets/00f7eb2f-2d16-4e9a-b516-c730752eed49" />
</p>
<br>

## What You Can Bind

Each item is optional. Leave it on **(No change)** and it won't be touched.

### 1. UI Theme
Switches to the chosen theme when the chat opens.

### 2. Connection
Choose **one** of two ways to set up the connection. Only the selected mode is applied; the other mode's settings are kept but greyed out and ignored.

- **Connection Profile:** switches to a saved profile from SillyTavern's built-in Connection Profiles extension. A profile can cover the API type, source, model, and templates in one go, so it also works with Text Completion.
- **Preset + Model:** Chat Completion only. Pick a preset, pick a source from SillyTavern's own list, then type the model name yourself. Any model ID works, even ones that aren't in the dropdown.
  - Applied in this order: **preset → source → model**.
  - Leave the source on **(No change)** to apply the model to whichever source is active.

When a profile, source, or model actually changes, a toast tells you where your chat is now going.

### 3. Background
Binds a background to the chat using SillyTavern's own **Lock**, so it stays in sync with the Backgrounds panel (locking, unlocking, or picking another background while locked updates the binding too).

- Pick from a searchable thumbnail gallery, or enter an image URL directly (the URL takes priority).
- Adjust thumbnail size with the slider.
- **Preload backgrounds** keeps up to 10 recent bound images in memory for faster switching. Off by default, uses extra memory.

### 4. Quick Reply Sets
- **Characters:** checked sets are applied directly to SillyTavern's Character Quick Reply Set.
- **Groups:** groups have no Character QR sets, so checked sets are linked to the chat whenever you open a chat in that group.

### 5. Additional Custom CSS
Add as many CSS snippets as you like. Each has its own name, on/off switch, rename, and delete. Applied after the theme's Custom CSS, so yours wins when selectors match.


