import { NextResponse } from 'next/server';
import { quotaUsed } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const used = quotaUsed();
  const remaining = Math.max(0, 10000 - used);
  return NextResponse.json({ used, remaining, searchesLeft: Math.floor(remaining / 101) });
}
