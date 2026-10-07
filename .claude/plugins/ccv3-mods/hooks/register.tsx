import type { Register } from 'claude-code'

import { agenticOs } from './agentic-os/index'

export const register: Register = on => {
  agenticOs(on)
}
