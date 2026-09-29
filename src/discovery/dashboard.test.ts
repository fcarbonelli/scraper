/**
 * Pure pieces of the dashboard contract: chain channels, mapping origin,
 * sweep pinning in the job list, and the weekly altas rollup.
 */

import { describe, expect, it } from 'vitest';
import { channelsForChain } from '../shared/chainProfile.js';
import { classifyMappingOrigin } from './origins.js';
import { selectDiscoveryList } from './listing.js';
import { buildWeeklyReport, recentIsoWeeks } from './weeklyReport.js';
import { branchKey } from '../instore/branch.js';
import { thumbUrl } from '../instore/thumbs.js';

describe('channelsForChain', () => {
  it('marks a web adapter as online and stacks in-store and revista on the same id', () => {
    expect(channelsForChain(true, {})).toEqual(['online']);
    expect(channelsForChain(true, { instore: { enabled: true } })).toEqual(['online', 'presencial']);
    expect(
      channelsForChain(false, {
        source_type: 'revista',
        instore: { enabled: true },
        revista: { strategy: 'html-pdf-links' },
      }),
    ).toEqual(['presencial', 'revistas']);
    expect(channelsForChain(false, { source_type: 'instore', instore: { enabled: true } })).toEqual([
      'presencial',
    ]);
  });
});

describe('classifyMappingOrigin', () => {
  it('trusts stamps and prefixes, and treats an unstamped URL by search ability', () => {
    expect(
      classifyMappingOrigin({ externalId: 'instore-abc', metadata: {}, hasSearch: true }),
    ).toBe('instore');
    expect(
      classifyMappingOrigin({ externalId: 'revista-abc', metadata: {}, hasSearch: false }),
    ).toBe('revista');
    expect(
      classifyMappingOrigin({
        externalId: '123',
        metadata: { source: 'discover' },
        hasSearch: true,
      }),
    ).toBe('scrape');
    expect(
      classifyMappingOrigin({
        externalId: '123',
        metadata: { source: 'manual_url' },
        hasSearch: true,
      }),
    ).toBe('manual_url');
    expect(classifyMappingOrigin({ externalId: '123', metadata: {}, hasSearch: false })).toBe(
      'manual_url',
    );
    expect(classifyMappingOrigin({ externalId: '123', metadata: {}, hasSearch: true })).toBe('scrape');
  });
});

describe('selectDiscoveryList', () => {
  it('keeps a sweep that small jobs would otherwise push off a 100-item page', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    const jobs = [
      { jobId: 'sweep-sunday', scope: 'sweep', createdAt: '2026-09-27T05:00:00.000Z' },
      ...Array.from({ length: 120 }, (_, i) => ({
        jobId: `ean-${i}`,
        scope: 'ean',
        createdAt: new Date(now - i * 60_000).toISOString(),
      })),
    ];
    const page = selectDiscoveryList(jobs, { limit: 100, pinSweeps: true, nowMs: now });
    expect(page).toHaveLength(100);
    expect(page.some((j) => j.jobId === 'sweep-sunday')).toBe(true);
    expect(page[0]?.createdAt >= page[1]!.createdAt).toBe(true);
  });
});

describe('buildWeeklyReport', () => {
  it('counts altas by origin and attaches the sweep only on searchable chains', () => {
    const weeks = recentIsoWeeks('2026-09-29', 1);
    const week = weeks[0]!.label;
    const report = buildWeeklyReport({
      weeks,
      chains: [
        { id: 'coto', hasSearch: false, channels: ['online'] },
        { id: 'carrefour', hasSearch: true, channels: ['online', 'presencial'] },
      ],
      mappings: [
        {
          supermarketId: 'coto',
          createdAt: '2026-09-28T15:00:00.000Z',
          externalId: 'instore-1',
          metadata: { source: 'instore' },
        },
        {
          supermarketId: 'carrefour',
          createdAt: '2026-09-28T15:00:00.000Z',
          externalId: '99',
          metadata: { source: 'discover' },
        },
      ],
      sweeps: [
        {
          id: 'job-1',
          createdAt: '2026-09-28T05:00:00.000Z',
          chains: [{ supermarket_id: 'carrefour', ingested: 9, not_found: 140, errors: 2 }],
        },
      ],
    });
    expect(report).toHaveLength(1);
    expect(report[0]?.week).toBe(week);
    expect(report[0]?.sweep_job_id).toBe('job-1');
    const coto = report[0]?.chains.find((c) => c.supermarket_id === 'coto');
    const carrefour = report[0]?.chains.find((c) => c.supermarket_id === 'carrefour');
    expect(coto).toMatchObject({
      has_search: false,
      mappings_added: 1,
      mappings_added_by: { instore: 1, scrape: 0, manual_url: 0, revista: 0 },
      sweep: null,
    });
    expect(carrefour).toMatchObject({
      has_search: true,
      mappings_added: 1,
      sweep: { ingested: 9, not_found: 140, errors: 2 },
    });
  });
});

describe('branchKey', () => {
  it('treats spacing and case as the same branch', () => {
    expect(branchKey('San Martín', 'Av. San Martín  123')).toBe(
      branchKey('san martín', 'av. san martín 123'),
    );
  });
});

describe('thumbUrl', () => {
  it('rewrites a Supabase object URL and leaves an external CDN alone', () => {
    expect(
      thumbUrl('https://abc.supabase.co/storage/v1/object/public/instore-photos/v/a.jpg', 320),
    ).toBe(
      'https://abc.supabase.co/storage/v1/render/image/public/instore-photos/v/a.jpg?width=320&resize=contain',
    );
    expect(thumbUrl('https://cdn.example/p.jpg', 320)).toBe('https://cdn.example/p.jpg');
    expect(thumbUrl(null)).toBeNull();
  });
});
