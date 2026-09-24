// Host typings drift: @deepseek-ai/dsh-llm 0.1.7-alpha.2 does not yet declare
// the `plugin` member of MessageSourceMap, but its own runtime writes
// `{ kind: 'plugin', plugin: string }` sources. Augment the map here following
// the host's merge-extensible convention (cf. dsh-agent model-selection.d.ts),
// matching the host runtime shape exactly so a future native member merges
// without conflict.
import '@deepseek-ai/dsh-llm';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    plugin: { kind: 'plugin'; plugin: string };
  }
}
