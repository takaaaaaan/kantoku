declare module 'claude-code' {
  interface PluginState {
    // Whether the person wants the Manager panel up in this session: set by
    // `/kantoku-panel show|hide|toggle` and by closing the pane. Unset until
    // then, when the `showPanelOnStart` option decides.
    kantoku: { isPanelWanted: boolean }
  }
}
