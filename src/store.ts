import { create } from 'zustand';
import type { Carousel, Decision, Item, Photo, Section, StyleOptions } from './types';
import { VARIANTS, addBridges, compatibleTemplates, generateCarousel, rebuildSection, templateById } from './lib/layout';
import { analyzeAll, buildDecisions, curate, groupDuplicates, tiltVerdict, type Progress, type Sequence } from './lib/curate';
import { fitBox, photoOrientation } from './lib/geometry';
import { level, unstraighten } from './lib/straighten';

export type Step = 'import' | 'curate' | 'compose' | 'export';

interface State {
  step: Step;
  photos: Photo[];
  byId: Map<string, Photo>;
  importing: { done: number; total: number } | null;
  analyzing: Progress | null;
  smartMode: boolean | null;
  picks: string[];
  count: number;
  seq: Sequence;
  style: StyleOptions;
  carousels: Carousel[];
  active: number;
  selected: { sectionId: string; itemId: string } | null;
  /** Calls the scores can't make alone; the user decides. */
  decisions: Decision[];
  askOpen: boolean;

  setStep: (s: Step) => void;
  addPhotos: (ps: Photo[]) => void;
  setImporting: (p: State['importing']) => void;
  analyze: () => Promise<void>;
  autoPick: () => void;
  togglePick: (id: string) => void;
  movePick: (id: string, to: number) => void;
  setCount: (n: number) => void;
  setSeq: (s: Sequence) => void;
  setStyle: (s: Partial<StyleOptions>) => void;
  compose: (reseed?: boolean) => void;
  setActive: (i: number) => void;
  select: (s: State['selected']) => void;
  updateItem: (sectionId: string, itemId: string, patch: Partial<Item>) => void;
  moveSection: (sectionId: string, dir: -1 | 1) => void;
  shuffleSection: (sectionId: string) => void;
  removeSection: (sectionId: string) => void;
  removeItem: (sectionId: string, itemId: string) => void;
  swapPhoto: (sectionId: string, itemId: string, photoId: string) => void;
  appendPhoto: (photoId: string) => void;
  reset: () => void;
  setAskOpen: (open: boolean) => void;
  resolve: (id: string, choice: string | boolean) => Promise<void>;
  setStraight: (photoId: string, on: boolean) => Promise<void>;
}

const defaultStyle: StyleOptions = {
  families: { pano: true, layered: true, gallery: true },
  bg: '#0d0d0d',
  frame: '#f4f1ea',
  maxSlides: 20,
};

export const useStore = create<State>((set, get) => {
  const editActive = (fn: (c: Carousel) => Carousel) =>
    set((s) => ({ carousels: s.carousels.map((c, i) => (i === s.active ? fn(c) : c)) }));
  const editSection = (id: string, fn: (sec: Section) => Section) =>
    editActive((c) => ({ ...c, sections: c.sections.map((s) => (s.id === id ? fn(s) : s)) }));
  const replacePhoto = (id: string, patch: Partial<Photo>) =>
    set((s) => {
      const photos = s.photos.map((p) => (p.id === id ? { ...p, ...patch } : p));
      return { photos, byId: new Map(photos.map((p) => [p.id, p])) };
    });
  /** Strong, unused photos for laying over seams. */
  const reserveFor = (c: Carousel) => {
    const { photos, picks, byId } = get();
    const used = new Set(c.sections.flatMap((s) => s.items.map((i) => i.photoId)));
    const leftover = picks.filter((id) => !used.has(id)).map((id) => byId.get(id)!);
    const extra = photos
      .filter((p) => !used.has(p.id) && !picks.includes(p.id) && p.analysis && !p.analysis.reject && p.analysis.groupBest !== false)
      .sort((a, b) => b.analysis!.score - a.analysis!.score);
    return [...leftover, ...extra];
  };

  return {
    step: 'import',
    photos: [],
    byId: new Map(),
    importing: null,
    analyzing: null,
    smartMode: null,
    picks: [],
    count: 30,
    seq: 'story',
    style: defaultStyle,
    carousels: [],
    active: 0,
    selected: null,
    decisions: [],
    askOpen: false,

    setStep: (step) => set({ step }),
    addPhotos: (ps) =>
      set((s) => {
        const photos = [...s.photos, ...ps].sort((a, b) => a.date - b.date);
        return { photos, byId: new Map(photos.map((p) => [p.id, p])) };
      }),
    setImporting: (importing) => set({ importing }),

    analyze: async () => {
      const { photos } = get();
      const { hasClip } = await analyzeAll(
        photos,
        (analyzing) => set({ analyzing }),
        (id, a) => {
          const p = get().byId.get(id);
          if (p) p.analysis = a;
          set((s) => ({ photos: [...s.photos] }));
        },
      );
      groupDuplicates(get().photos);
      set((s) => ({ smartMode: hasClip, photos: [...s.photos] }));
      // Level clearly crooked keepers automatically (undo is in the photo's detail panel).
      const crooked = get().photos.filter((p) => p.analysis && !p.analysis.reject && !p.straightened && tiltVerdict(p.analysis) === 'fix');
      for (const [i, p] of crooked.entries()) {
        set({ analyzing: { stage: 'Straightening crooked shots', done: i, total: crooked.length } });
        replacePhoto(p.id, await level(p, p.analysis!.tilt!));
      }
      set({ analyzing: null });
      get().autoPick();
      if (get().decisions.length) set({ askOpen: true });
    },
    autoPick: () => {
      const { photos, count, seq } = get();
      const picks = curate(photos, count, seq);
      set({ picks, decisions: buildDecisions(photos, picks) });
    },
    setAskOpen: (askOpen) => set({ askOpen }),
    resolve: async (id, choice) => {
      const d = get().decisions.find((x) => x.id === id);
      set((s) => ({ decisions: s.decisions.filter((x) => x.id !== id) }));
      if (!d) return;
      if (d.kind === 'pick' && typeof choice === 'string') {
        // Swap the chosen frame into the picks where the group's current pick sits.
        for (const p of get().photos) if (p.analysis?.groupId === d.groupId) p.analysis.groupBest = p.id === choice;
        set((s) => {
          const inGroup = new Set(d.options);
          const at = s.picks.findIndex((x) => inGroup.has(x));
          const picks = s.picks.filter((x) => !inGroup.has(x));
          picks.splice(at < 0 ? picks.length : at, 0, choice);
          return { picks, photos: [...s.photos] };
        });
      }
      if (d.kind === 'straighten' && choice === true) await get().setStraight(d.photoId, true);
    },
    setStraight: async (photoId, on) => {
      const p = get().byId.get(photoId);
      if (!p) return;
      if (on && p.analysis?.tilt) replacePhoto(photoId, await level(p, p.analysis.tilt));
      if (!on) replacePhoto(photoId, unstraighten(p));
    },
    togglePick: (id) => set((s) => ({ picks: s.picks.includes(id) ? s.picks.filter((x) => x !== id) : [...s.picks, id] })),
    movePick: (id, to) =>
      set((s) => {
        const picks = s.picks.filter((x) => x !== id);
        picks.splice(to, 0, id);
        return { picks };
      }),
    setCount: (count) => {
      set({ count });
      if (get().photos.some((p) => p.analysis)) get().autoPick();
    },
    setSeq: (seq) => {
      set({ seq });
      if (get().photos.some((p) => p.analysis)) get().autoPick();
    },
    setStyle: (patch) => {
      set((s) => ({ style: { ...s.style, ...patch } }));
      if (patch.maxSlides && get().carousels.length) get().compose(false);
    },

    compose: (reseed) => {
      const { picks, byId, style, carousels } = get();
      const ps = picks.map((id) => byId.get(id)!).filter(Boolean);
      const base = reseed || !carousels.length ? Math.floor(Math.random() * 1e9) : carousels[0].seed;
      set({
        carousels: VARIANTS.map((v, i) => {
          const c = generateCarousel(ps, style, base + i * 7919, v);
          return addBridges(c, reserveFor(c), byId, base + i);
        }),
        selected: null,
        step: 'compose',
      });
    },
    setActive: (active) => set({ active, selected: null }),
    select: (selected) => set({ selected }),
    updateItem: (sectionId, itemId, patch) =>
      editSection(sectionId, (s) => ({ ...s, items: s.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) })),
    moveSection: (id, dir) =>
      editActive((c) => {
        const i = c.sections.findIndex((s) => s.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= c.sections.length) return c;
        const sections = [...c.sections];
        [sections[i], sections[j]] = [sections[j], sections[i]];
        return { ...c, sections };
      }),
    shuffleSection: (id) => {
      const { byId, style } = get();
      editSection(id, (sec) => {
        const ps = sec.photoIds.map((p) => byId.get(p)!);
        const opts = compatibleTemplates(ps, style);
        if (!opts.length) return sec;
        const i = opts.findIndex((t) => t.id === sec.template);
        // Cycle through templates; when it wraps, re-roll the same one for a fresh variation.
        const t = opts[(i + 1) % opts.length];
        return rebuildSection(sec, t, ps, style, Math.floor(Math.random() * 1e9));
      });
      set({ selected: null });
    },
    removeItem: (sectionId, itemId) => {
      editSection(sectionId, (sec) => {
        const items = sec.items.filter((i) => i.id !== itemId);
        return { ...sec, items, photoIds: items.filter((i) => !i.bridge).map((i) => i.photoId) };
      });
      set({ selected: null });
    },
    removeSection: (id) => {
      editActive((c) => ({ ...c, sections: c.sections.filter((s) => s.id !== id) }));
      set({ selected: null });
    },
    swapPhoto: (sectionId, itemId, photoId) => {
      const { byId, style } = get();
      editSection(sectionId, (sec) => {
        const item = sec.items.find((it) => it.id === itemId);
        if (item?.bridge) {
          // Seam photos keep their spot and width; the height follows the new photo.
          const p = byId.get(photoId)!;
          const box = fitBox(p.width / p.height, item.w, 640);
          return { ...sec, items: sec.items.map((it) => (it === item ? { ...it, photoId, w: box.w, h: box.h, crop: { fx: 0.5, fy: 0.5, zoom: 1 } } : it)) };
        }
        const layout = sec.items.filter((it) => !it.bridge);
        const idx = layout.findIndex((it) => it.id === itemId);
        const photoIds = layout.map((it, i) => (i === idx ? photoId : it.photoId));
        const ps = photoIds.map((p) => byId.get(p)!);
        const t = templateById(sec.template);
        // Keep the layout if the new photo fits its slot; otherwise just recrop into the same frame.
        const fits = t.slots[idx]?.includes(photoOrientation(byId.get(photoId)!));
        if (fits) return rebuildSection(sec, t, ps, style, Math.floor(Math.random() * 1e9));
        return {
          ...sec,
          photoIds,
          items: sec.items.map((it) => (it.id === itemId ? { ...it, photoId, crop: { fx: 0.5, fy: 0.5, zoom: 1 } } : it)),
        };
      });
      set({ selected: null });
    },
    appendPhoto: (photoId) => {
      const { byId, style } = get();
      const p = byId.get(photoId)!;
      const o = photoOrientation(p);
      const t = templateById(o === 'pano' ? 'pano2' : o === 'landscape' ? (style.families.pano ? 'pano2' : 'framed') : 'full');
      editActive((c) => ({ ...c, sections: [...c.sections, rebuildSection({ id: `sec_${photoId}_${Date.now()}` } as Section, t, [p], style, Date.now())] }));
    },
    reset: () => set({ step: 'import', photos: [], byId: new Map(), picks: [], carousels: [], selected: null, smartMode: null, decisions: [], askOpen: false }),
  };
});

// Handy for debugging and automated tests in development builds.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__seam = useStore;
