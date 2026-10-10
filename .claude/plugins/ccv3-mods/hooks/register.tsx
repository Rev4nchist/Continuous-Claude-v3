import type { Register } from 'claude-code'

import { agentLedger } from './agent-ledger/index'
import { agenticOs } from './agentic-os/index'
import { cacheGuard } from './cache-guard/index'
import { hudCapture } from './hud/index'
import { prLoop } from './pr-loop/index'
import { skin } from './skin/index'
import { touchedFiles } from './touched-files/index'

export const register: Register = on => {
  // First: its AbovePrompt card replaces the agentic-os band while a send is held.
  cacheGuard(on)
  agenticOs(on)
  hudCapture(on)
  agentLedger(on)
  touchedFiles(on)
  skin(on)
  prLoop(on)
}
