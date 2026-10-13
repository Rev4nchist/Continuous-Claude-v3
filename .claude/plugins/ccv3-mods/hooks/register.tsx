import type { Register } from 'claude-code'

import { agentLedger } from './agent-ledger/index'
import { agenticOs } from './agentic-os/index'
import { hudCapture } from './hud/index'
import { prLoop } from './pr-loop/index'
import { touchedFiles } from './touched-files/index'

// Cache Guard and Skin were desktop-only and are archived in archive/ccv3-mods-desktop-2026-10.
export const register: Register = on => {
  agenticOs(on)
  hudCapture(on)
  agentLedger(on)
  touchedFiles(on)
  prLoop(on)
}
