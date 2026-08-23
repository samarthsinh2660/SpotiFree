import { NextRequest, NextResponse } from 'next/server';
import { fetchPlaylist, parsePlaylistId, HttpError } from '@/lib/spotify';
import { countCached } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  try {
    const id = parsePlaylistId(req.nextUrl.searchParams.get('url'));
    if (!id) throw new HttpError(400, 'That does not look like a Spotify playlist link.');

    const playlist = await fetchPlaylist(id);
    return NextResponse.json({
      ...playlist,
      cachedCount: countCached(playlist.tracks.map((t) => t.id)),
    });
  } catch (err) {
    const e = err as HttpError;
    if (!e.status) console.error(err);
    return NextResponse.json(
      { error: e.message || 'Something went wrong', code: e.code || 'upstream' },
      { status: e.status || 500 }
    );
  }
}
