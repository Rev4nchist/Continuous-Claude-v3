import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** The shadcn/ui class merge helper. Required by every component in that registry. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
