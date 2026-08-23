import { NextRequest, NextResponse } from 'next/server';
import { listPlaylists, savePlaylist, removePlaylist } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({ playlists: listPlaylists() });
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  if (!body?.id || !body?.name || !body?.url) {
    return NextResponse.json({ error: 'id, name and url are required' }, { status: 400 });
  }
  savePlaylist({
    id: body.id,
    name: body.name,
    url: body.url,
    art: body.art ?? null,
    trackCount: body.trackCount ?? 0,
  });
  return NextResponse.json({ playlists: listPlaylists() });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id');
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 });
  removePlaylist(id);
  return NextResponse.json({ playlists: listPlaylists() });
}
