export function computeRunStatus({ deadlineExceeded = false, errors = [], completedSources = 0, videos = [], targets = [], changed = false } = {}) {
  if (deadlineExceeded) return 'Warn';
  if (errors.length) return completedSources > 0 ? 'Warn' : 'Failed';
  if (videos.some((video) => video.status !== 'Ready') || targets.some((target) => target.status !== 'Ready')) return 'Blocked';
  return changed ? 'Ready' : 'NoChange';
}
