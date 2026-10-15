'use client';

import { useConsole } from '../lib/useConsole';
import { Shell } from '../components/Shell';

export default function Console() {
  const s = useConsole();
  return <Shell s={s} />;
}
