// The seam between "how GitHub events reach this machine" and everything else.
// Stage 1 is relays/gh-forward.ts; a GitHub App relay can replace it later.

import type { Trouble } from './events.ts'

export type Relay = {
  name: string
  preflight(): Promise<Trouble[]>
  sync(repos: string[]): Promise<void>
  stop(): Promise<void>
  onConnected(listener: (repo: string) => void): void
  onTrouble(listener: (repo: string, problem: Trouble, detail: string) => void): void
}
