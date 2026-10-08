import type { Register } from 'claude-code'

import { agenticOs } from './agentic-os/index'
import { prLoop } from './pr-loop/index'

export const register: Register = on => {
  agenticOs(on)
  prLoop(on)
}
