import { NextRequest, NextResponse } from 'next/server';
import { HttpError } from '@/lib/spotify';
import { findBestMatch } from '@/lib/youtube';
import { getMapping, putMapping, dropMapping } from '@/lib/cache';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  try {
    const id = q.get('id');
    const title = q.get('title');
    if (!id || !title) throw new HttpError(400, 'id and title are required');

    if (q.get('retry') === '1') {
      dropMapping(id);                       // user rejected the cached match
    } else {
      const hit = getMapping(id);
      if (hit) return NextResponse.json({ videoId: hit, cached: true });
    }

    const best = await findBestMatch({
      title,
      artists: q.get('artists') || '',
      durationMs: Number(q.get('dur')) || 0,
    });
    if (!best) throw new HttpError(404, `No YouTube match found for "${title}"`);

    putMapping(id, best.videoId, best.title);
    return NextResponse.json({
      videoId: best.videoId,
      cached: false,
      label: best.title,
      channel: best.channelTitle,
    });
  } catch (err) {
    const e = err as HttpError;
    if (!e.status) console.error(err);
    return NextResponse.json({ error: e.message || 'Something went wrong' }, { status: e.status || 500 });
  }
}
