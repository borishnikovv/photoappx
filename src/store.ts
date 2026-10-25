import { create } from 'zustand';
import type { Carousel, Decision, Item, Photo, Section, StyleOptions } from './types';
import { VARIANTS, addBridges, fixSlivers, groundFor, recoverSection, compatibleTemplates, generateCarousel, rebuildSection, templateById } from './lib/layout';
import { analyzeAll, resetClip, buildDecisions, curate, distance, sameSceneFor, groupDuplicates, keystoneVerdict, tiltVerdict, type Progress, type Sequence } from './lib/curate';
import { fitBox, photoOrientation } from './lib/geometry';
import { level, straighten, unstraighten } from './lib/straighten';
import { loadProject, type Draft } from './lib/projects';

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

  /** The project this work autosaves into (see lib/autosave.ts). */
  projectId: string | null;
  projectName: string;
  createdAt: number;
  /** Named snapshots of the layouts, to try a direction and come back. */
  drafts: Draft[];
  saveDraft: () => void;
  restoreDraft: (id: string) => void;
  deleteDraft: (id: string) => void;
  openProject: (id: string) => Promise<boolean>;

  setStep: (s: Step) => void;
  addPhotos: (ps: Photo[], name?: string) => void;
  setImporting: (p: State['importing']) => void;
  analyze: () => Promise<void>;
  /** Basic mode → try loading the art-director model again and re-review with it. */
  retryModel: () => Promise<void>;
  autoPick: () => void;
  togglePick: (id: string) => void;
  movePick: (id: string, to: number) => void;
  setCount: (n: number) => void;
  setSeq: (s: Sequence) => void;
  setStyle: (s: Partial<StyleOptions>) => void;
  compose: (reseed?: boolean) => void;
  /** Same as compose, but lets the UI show "Arranging…" first (laying out takes a moment). */
  arrange: (reseed?: boolean) => void;
  arranging: boolean;
  setActive: (i: number) => void;
  select: (s: State['selected']) => void;
  updateItem: (sectionId: string, itemId: string, patch: Partial<Item>) => void;
  moveSection: (sectionId: string, dir: -1 | 1) => void;
  shuffleSection: (sectionId: string) => void;
  removeSection: (sectionId: string) => void;
  removeItem: (sectionId: string, itemId: string) => void;
  /** Forward: above everything it overlaps. Back: beneath the other photos on top, never under the backdrop. */
  restack: (sectionId: string, itemId: string, to: 'front' | 'back') => void;
  swapPhoto: (sectionId: string, itemId: string, photoId: string) => void;
  appendPhoto: (photoId: string) => void;
  reset: () => void;
  setAskOpen: (open: boolean) => void;
  resolve: (id: string, choice: string | boolean) => Promise<void>;
  /** Answered questions, newest first, with what each changed, so "Back" can undo them. */
  answered: { decision: Decision; picks: string[]; groupBest: [string, boolean | undefined][]; photo?: Photo }[];
  undoAnswer: () => void;
  /** on/off uses the detected tilt; a number sets the correction by hand (0 = as shot). */
  /** on/off uses what was detected; { tilt, keystone } sets the correction by hand (0, 0 = as shot). */
  setStraight: (photoId: string, on: boolean | { tilt: number; keystone: number }) => Promise<void>;
  /** Editor history: every layout change can be undone and redone. */
  past: { carousels: Carousel[]; active: number }[];
  future: { carousels: Carousel[]; active: number }[];
  undo: () => void;
  redo: () => void;
  /** Keep this section exactly as is when regenerating. */
  togglePin: (sectionId: string) => void;
  /** Trade the photos in two frames (they can be in different layouts); each frame keeps its shape. */
  swapItems: (a: { sectionId: string; itemId: string }, b: { sectionId: string; itemId: string }) => void;
  /** Replace a section with one of its alternatives (seam photos stay). */
  replaceSection: (sectionId: string, next: Section) => void;
}

const defaultStyle: StyleOptions = {
  families: { mosaic: true, spread: true, pano: true, layered: true, gallery: true },
  bg: 'auto',
  frame: '#f4f1ea',
  overlay: 'clean',
  look: 'natural',
  matchTones: true,
  bwAccents: false,
  maxSlides: 20,
};

/**
 * Black-and-white accents: about a quarter of the frames on top, the least colorful ones first
 * (they lose least), never two side by side in the same layout.
 */
function withAccents(c: Carousel, byId: Map<string, Photo>, on: boolean): Carousel {
  const clear = c.sections.map((s) => ({ ...s, items: s.items.map((i) => ({ ...i, mono: false })) }));
  if (!on) return { ...c, sections: clear };
  const ovs = clear.flatMap((s) => s.items.filter((i) => !i.base).map((i) => ({ s, i })));
  const want = Math.max(1, Math.round(ovs.length * 0.25));
  const ranked = [...ovs].sort((a, b) => (byId.get(a.i.photoId)?.analysis?.colorfulness ?? 0.5) - (byId.get(b.i.photoId)?.analysis?.colorfulness ?? 0.5));
  const picked = new Set<string>();
  const usedSections = new Set<string>();
  for (const { s, i } of ranked) {
    if (picked.size >= want) break;
    if (usedSections.has(s.id)) continue;
    picked.add(i.id);
    usedSections.add(s.id);
  }
  return { ...c, sections: clear.map((s) => ({ ...s, items: s.items.map((i) => (picked.has(i.id) ? { ...i, mono: true } : i)) })) };
}

export const useStore = create<State>((set, get) => {
  // History: snapshots of the layouts before each change. A stream of tiny changes to the same
  // thing (one drag, one slider move) coalesces into a single step.
  let lastKey = '', lastAt = 0;
  const checkpoint = (key = '') => {
    const now = Date.now();
    if (key && key === lastKey && now - lastAt < 800) {
      lastAt = now;
      return;
    }
    lastKey = key;
    lastAt = now;
    const { carousels, active, past } = get();
    if (!carousels.length) return;
    set({ past: [...past.slice(-49), { carousels, active }], future: [] });
  };
  const editActive = (fn: (c: Carousel) => Carousel, key = '') => {
    checkpoint(key);
    set((s) => ({ carousels: s.carousels.map((c, i) => (i === s.active ? fn(c) : c)) }));
  };
  const editSection = (id: string, fn: (sec: Section) => Section, key = '') =>
    editActive((c) => ({ ...c, sections: c.sections.map((s) => (s.id === id ? fn(s) : s)) }), key);
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
    const extra: Photo[] = [];
    const kept = [...used].map((id) => byId.get(id)?.analysis).filter((a) => a?.grid);
    const candidates = photos
      .filter((p) => !used.has(p.id) && !picks.includes(p.id) && p.analysis && !p.analysis.reject && p.analysis.groupBest !== false)
      // Seam photos are never asked about, so skip any that might still be crooked.
      .filter((p) => p.straightened != null || !tiltVerdict(p.analysis))
      .sort((a, b) => b.analysis!.score - a.analysis!.score);
    // …and only ones that add something new: not a near-repeat of anything in the carousel or pool.
    const sameScene = sameSceneFor(photos.filter((p) => p.analysis?.grid && !p.analysis.reject).map((p) => p.analysis!));
    for (const p of candidates) {
      if (kept.every((q) => distance(p.analysis!, q!) > sameScene)) {
        extra.push(p);
        kept.push(p.analysis);
      }
    }
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
    arranging: false,
    answered: [],
    past: [],
    future: [],
    projectId: null,
    projectName: '',
    createdAt: 0,
    drafts: [],

    saveDraft: () => {
      const { carousels, active, style, drafts } = get();
      if (!carousels.length) return;
      const n = drafts.length ? Math.max(...drafts.map((d) => +d.name.replace(/\D/g, '') || 0)) + 1 : 1;
      const d: Draft = { id: `d_${Date.now().toString(36)}`, name: `Draft ${n}`, savedAt: Date.now(), carousels, active, style };
      // Up to five; the oldest goes first.
      set({ drafts: [d, ...drafts].slice(0, 5) });
    },
    restoreDraft: (id) => {
      const d = get().drafts.find((x) => x.id === id);
      if (!d) return;
      checkpoint();
      set({ carousels: d.carousels, active: d.active, style: d.style, selected: null });
    },
    deleteDraft: (id) => set((s) => ({ drafts: s.drafts.filter((d) => d.id !== id) })),
    openProject: async (id) => {
      const got = await loadProject(id).catch(() => null);
      if (!got) return false;
      const { state: st, photos: loaded } = got;
      const order = new Map(st.photoIds.map((pid, i) => [pid, i]));
      const photos = loaded.filter((p) => order.has(p.id)).sort((a, b) => order.get(a.id)! - order.get(b.id)!);
      const groups = new Map(st.groups.map(([pid, g, b]) => [pid, { g, b }]));
      for (const p of photos) {
        const g = groups.get(p.id);
        if (p.analysis && g) Object.assign(p.analysis, { groupId: g.g, groupBest: g.b });
      }
      const unfinished = photos.some((p) => !p.analysis);
      set({
        projectId: st.id,
        projectName: st.name,
        createdAt: st.createdAt,
        photos,
        byId: new Map(photos.map((p) => [p.id, p])),
        picks: st.picks.filter((pid) => order.has(pid)),
        count: st.count,
        seq: st.seq as Sequence,
        style: { ...defaultStyle, ...st.style },
        carousels: st.carousels,
        active: st.active,
        decisions: st.decisions,
        drafts: st.drafts ?? [],
        smartMode: st.smartMode,
        step: unfinished ? 'curate' : ((st.step as Step) === 'export' ? 'compose' : (st.step as Step)) || 'curate',
        selected: null,
        answered: [],
        past: [],
        future: [],
        askOpen: false,
      });
      // Picks up where it left off: only the photos not reviewed yet are analyzed.
      if (unfinished) get().analyze();
      return true;
    },

    setStep: (step) => set({ step }),
    addPhotos: (ps, name) =>
      set((s) => {
        const photos = [...s.photos, ...ps].sort((a, b) => a.date - b.date);
        const fresh = !s.projectId;
        const when = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
        return {
          photos,
          byId: new Map(photos.map((p) => [p.id, p])),
          ...(fresh && { projectId: `p_${Date.now().toString(36)}`, projectName: name || `Photos · ${when}`, createdAt: Date.now(), drafts: [] }),
        };
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
      const crooked = get().photos.filter(
        (p) => p.analysis && !p.analysis.reject && p.straightened == null && (tiltVerdict(p.analysis) === 'fix' || keystoneVerdict(p.analysis) === 'fix'),
      );
      for (const [i, p] of crooked.entries()) {
        set({ analyzing: { stage: 'Straightening crooked shots', done: i, total: crooked.length } });
        const a = p.analysis!;
        replacePhoto(p.id, await level(p, tiltVerdict(a) === 'fix' ? a.tilt! : 0, keystoneVerdict(a) === 'fix' ? a.keystone! : 0));
      }
      set({ analyzing: null });
      get().autoPick();
      if (get().decisions.length) set({ askOpen: true });
    },
    retryModel: async () => {
      resetClip();
      // Re-review from scratch: the model changes scores, so picks and duplicate groups are redone.
      for (const p of get().photos) p.analysis = undefined;
      set((s) => ({ smartMode: null, decisions: [], answered: [], photos: [...s.photos] }));
      await get().analyze();
    },
    autoPick: () => {
      const { photos, count, seq } = get();
      const picks = curate(photos, count, seq);
      set({ picks, decisions: buildDecisions(photos, picks) });
    },
    setAskOpen: (askOpen) => set({ askOpen }),
    resolve: async (id, choice) => {
      const d = get().decisions.find((x) => x.id === id);
      if (!d) return;
      // Remember exactly what this answer changes, so it can be taken back.
      const { picks, photos, byId } = get();
      const snapshot = {
        decision: d,
        picks: [...picks],
        groupBest: d.kind === 'pick' ? photos.filter((p) => p.analysis?.groupId === d.groupId).map((p) => [p.id, p.analysis!.groupBest] as [string, boolean | undefined]) : [],
        photo: d.kind === 'straighten' ? byId.get(d.photoId) : undefined,
      };
      set((s) => ({ decisions: s.decisions.filter((x) => x.id !== id), answered: [snapshot, ...s.answered] }));
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
    undoAnswer: () => {
      const [last, ...rest] = get().answered;
      if (!last) return;
      for (const [id, best] of last.groupBest) {
        const a = get().byId.get(id)?.analysis;
        if (a) a.groupBest = best;
      }
      if (last.photo) {
        const prev = last.photo;
        set((s) => {
          const photos = s.photos.map((p) => (p.id === prev.id ? prev : p));
          return { photos, byId: new Map(photos.map((p) => [p.id, p])) };
        });
      }
      set((s) => ({ picks: last.picks, answered: rest, decisions: [last.decision, ...s.decisions], photos: [...s.photos] }));
    },
    setStraight: async (photoId, on) => {
      const p = get().byId.get(photoId);
      if (!p) return;
      if (typeof on === 'object') {
        const none = Math.abs(on.tilt) < 0.05 && Math.abs(on.keystone) < 0.05;
        replacePhoto(photoId, none ? unstraighten(p) : await straighten(p, on.tilt, on.keystone));
        set((s) => ({ decisions: s.decisions.filter((d) => !(d.kind === 'straighten' && d.photoId === photoId)) }));
        return;
      }
      if (on && p.analysis) replacePhoto(photoId, await level(p, p.analysis.tilt ?? 0, keystoneVerdict(p.analysis) === 'fix' ? p.analysis.keystone! : 0));
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
      // Changes that affect layout re-run it with the same seed, so the arrangement stays recognisable.
      if ((patch.maxSlides || patch.overlay || patch.families) && get().carousels.length) get().compose(false);
      else if (patch.bwAccents != null && get().carousels.length) {
        checkpoint();
        set((s) => ({ carousels: s.carousels.map((c) => withAccents(c, s.byId, !!patch.bwAccents)) }));
      }
    },

    compose: (reseed) => {
      const { picks, byId, style, carousels, active } = get();
      checkpoint();
      // Pinned sections keep their place and photos; everything else is laid out around them.
      const pinned: { at: number; sec: Section }[] = [];
      let at = 0;
      for (const sec of carousels[active]?.sections ?? []) {
        if (sec.pinned) pinned.push({ at, sec });
        at += sec.span;
      }
      const held = new Set(pinned.flatMap((p) => p.sec.items.map((i) => i.photoId)));
      const ps = picks.filter((id) => !held.has(id)).map((id) => byId.get(id)!).filter(Boolean);
      const heldSlides = pinned.reduce((n, p) => n + p.sec.span, 0);
      const base = reseed || !carousels.length ? Math.floor(Math.random() * 1e9) : carousels[0].seed;
      const withPins = (c: Carousel): Carousel => {
        if (!pinned.length) return c;
        const sections = [...c.sections];
        for (const { at: want, sec } of pinned) {
          let idx = 0, slide = 0;
          while (idx < sections.length && slide + sections[idx].span <= want) slide += sections[idx++].span;
          sections.splice(idx, 0, sec);
        }
        return { ...c, sections };
      };
      set({
        carousels: VARIANTS.map((v, i) => {
          const c = withPins(generateCarousel(ps, { ...style, maxSlides: Math.max(1, style.maxSlides - heldSlides) }, base + i * 7919, v));
          const laid = { ...fixSlivers(addBridges(fixSlivers(c), reserveFor(c), byId, style, base + i)), ground: groundFor(picks.map((id) => byId.get(id)!).filter(Boolean)) };
          return style.bwAccents ? withAccents(laid, byId, true) : laid;
        }),
        selected: null,
        step: 'compose',
      });
    },
    undo: () => {
      const { past, future, carousels, active } = get();
      const prev = past[past.length - 1];
      if (!prev) return;
      lastKey = '';
      set({ past: past.slice(0, -1), future: [{ carousels, active }, ...future], carousels: prev.carousels, active: prev.active, selected: null });
    },
    redo: () => {
      const { past, future, carousels, active } = get();
      const next = future[0];
      if (!next) return;
      lastKey = '';
      set({ future: future.slice(1), past: [...past, { carousels, active }], carousels: next.carousels, active: next.active, selected: null });
    },
    togglePin: (id) => editSection(id, (sec) => ({ ...sec, pinned: !sec.pinned })),
    swapItems: (a, b) => {
      const c = get().carousels[get().active];
      const find = (r: { sectionId: string; itemId: string }) => c.sections.find((x) => x.id === r.sectionId)?.items.find((i) => i.id === r.itemId);
      const A = find(a), B = find(b);
      if (!A || !B || A === B) return;
      const reset = { fx: 0.5, fy: 0.5, zoom: 1 };
      editActive((car) => ({
        ...car,
        sections: car.sections.map((sec) => ({
          ...sec,
          items: sec.items.map((it) => (it.id === A.id ? { ...it, photoId: B.photoId, crop: reset } : it.id === B.id ? { ...it, photoId: A.photoId, crop: reset } : it)),
          photoIds: sec.photoIds.map((pid) => (sec.id === a.sectionId && pid === A.photoId ? B.photoId : sec.id === b.sectionId && pid === B.photoId ? A.photoId : pid)),
        })),
      }));
      set({ selected: b });
    },
    replaceSection: (id, next) => {
      editSection(id, (sec) => ({ ...next, id: sec.id, pinned: sec.pinned, items: [...next.items.filter((i) => !i.bridge), ...sec.items.filter((i) => i.bridge)] }));
      set({ selected: null });
    },
    arrange: (reseed) => {
      set({ arranging: true });
      setTimeout(() => {
        get().compose(reseed);
        set({ arranging: false });
      }, 30);
    },
    setActive: (active) => set({ active, selected: null }),
    select: (selected) => set({ selected }),
    updateItem: (sectionId, itemId, patch) =>
      editSection(sectionId, (s) => ({ ...s, items: s.items.map((it) => (it.id === itemId ? { ...it, ...patch } : it)) }), `item:${itemId}:${Object.keys(patch).sort().join(',')}`),
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
      const { byId } = get();
      editSection(sectionId, (sec) => {
        const items = sec.items.filter((i) => i.id !== itemId);
        // Removing a backdrop promotes another photo, so the slides never show empty canvas.
        return recoverSection({ ...sec, items, photoIds: items.filter((i) => !i.bridge).map((i) => i.photoId) }, byId);
      });
      set({ selected: null });
    },
    restack: (sectionId, itemId, to) =>
      editActive((c) => {
        // Compare in canvas coordinates: overlapping photos may belong to neighbouring sections.
        let start = 0;
        const all = c.sections.flatMap((sec) => {
          const o = start * 1080;
          start += sec.span;
          return sec.items.map((it) => ({ it, sec, x: o + it.x }));
        });
        const me = all.find((a) => a.it.id === itemId);
        if (!me || me.it.base) return c;
        const others = all.filter(
          (a) => a !== me && !a.it.base && a.x < me.x + me.it.w && a.x + a.it.w > me.x && a.it.y < me.it.y + me.it.h && a.it.y + a.it.h > me.it.y,
        );
        const z = !others.length
          ? me.it.z
          : to === 'front'
            ? Math.max(...others.map((a) => a.it.z)) + 1
            : Math.max(0.5, Math.min(...others.map((a) => a.it.z)) - 1);
        return {
          ...c,
          sections: c.sections.map((sec) =>
            sec.id !== sectionId ? sec : { ...sec, items: sec.items.map((it) => (it.id === itemId ? { ...it, z } : it)) },
          ),
        };
      }),
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
    reset: () => set({ projectId: null, projectName: '', drafts: [], step: 'import', photos: [], byId: new Map(), picks: [], carousels: [], selected: null, smartMode: null, decisions: [], askOpen: false, answered: [], past: [], future: [] }),
  };
});

// Handy for debugging and automated tests in development builds.
if (import.meta.env.DEV) (globalThis as Record<string, unknown>).__seam = useStore;
