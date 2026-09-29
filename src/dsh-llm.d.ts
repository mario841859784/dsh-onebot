// Host typings drift: @deepseek-ai/dsh-llm does not declare this plugin's own
// producer-owned message source kind. v4 session format rejects the retired
// `kind: 'plugin'` wrapper, and the v3→v4 converter maps this plugin's
// historical `{ kind: 'plugin', plugin: 'dsh-onebot' }` rows to the
// producer-owned kind `plugin:dsh-onebot` — the same kind this plugin writes
// going forward. Augment the map here following the host's merge-extensible
// convention (cf. dsh-agent model-selection.d.ts).
import '@deepseek-ai/dsh-llm';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'plugin:dsh-onebot': { kind: 'plugin:dsh-onebot' };
  }
}
