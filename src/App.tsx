import { useStore, type Step } from './store';
import { ImportView } from './components/ImportView';
import { CurateView } from './components/CurateView';
import { ComposeView } from './components/ComposeView';
import { ExportView } from './components/ExportView';

const STEPS: { id: Step; label: string }[] = [
  { id: 'import', label: 'Import' },
  { id: 'curate', label: 'Curate' },
  { id: 'compose', label: 'Compose' },
  { id: 'export', label: 'Export' },
];

export default function App() {
  const step = useStore((s) => s.step);
  const setStep = useStore((s) => s.setStep);
  const hasPhotos = useStore((s) => s.photos.length > 0);
  const hasCarousel = useStore((s) => s.carousels.length > 0);
  const enabled: Record<Step, boolean> = { import: true, curate: hasPhotos, compose: hasCarousel, export: hasCarousel };

  return (
    <div className="app">
      <header className="top">
        <div className="mark">
          <i />
          SEAM
        </div>
        <nav className="steps">
          {STEPS.map((s, i) => (
            <button key={s.id} disabled={!enabled[s.id]} aria-current={step === s.id ? 'step' : undefined} onClick={() => setStep(s.id)}>
              <b>0{i + 1}</b>
              {s.label}
            </button>
          ))}
        </nav>
      </header>
      <main>
        {step === 'import' && <ImportView />}
        {step === 'curate' && <CurateView />}
        {step === 'compose' && <ComposeView />}
        {step === 'export' && <ExportView />}
      </main>
    </div>
  );
}
