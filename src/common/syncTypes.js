// Keep legacy server adapters available for existing archives and version history.
// These categories no longer participate in the browser's sync workflow.
const disabledTypes = new Set([
  'novel_preset', 'kobold_preset', 'instruct', 'context', 'sysprompt', 'textgen_preset',
]);

export const isSyncTypeEnabled = contentType => !disabledTypes.has(contentType);
