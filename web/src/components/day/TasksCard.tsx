import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { Category, DayPayload, Task } from '../../../../shared/types.ts';
import { categoryColor } from '../../lib/store.ts';
import { Button, Card, CategoryDot, Icon, IconButton, TextInput, cx } from '../../ui/index.ts';
import { plural } from './plural.ts';

/** Nezavršeni po redosledu, pa završeni po vremenu završetka (isto kao server). */
function orderTasks(tasks: Task[]): { open: Task[]; done: Task[] } {
  const open = tasks.filter((t) => !t.done).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const done = tasks
    .filter((t) => t.done)
    .sort((a, b) => (a.doneAt ?? '').localeCompare(b.doneAt ?? '') || a.id - b.id);
  return { open, done };
}

export function TasksCard({
  tasks,
  openBefore,
  showCarry,
  catMap,
  onAdd,
  onToggle,
  onOpen,
  onCarry,
}: {
  tasks: Task[];
  openBefore: number;
  /** Prikaži traku "od ranije" (samo kad je na ekranu danas). */
  showCarry: boolean;
  catMap: Map<number, Category>;
  onAdd: (title: string) => Promise<DayPayload | null>;
  onToggle: (id: number, done: boolean) => void;
  onOpen: (task: Task) => void;
  onCarry: () => Promise<DayPayload | null>;
}) {
  const [text, setText] = useState('');
  const [carrying, setCarrying] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { open, done } = useMemo(() => orderTasks(tasks), [tasks]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const title = text.trim();
    if (!title) return;
    setText('');
    inputRef.current?.focus();
    const res = await onAdd(title);
    // Neuspeh: vrati tekst u polje (ako korisnik u međuvremenu nije počeo novi).
    if (!res) setText((cur) => cur || title);
  };

  const carry = async () => {
    setCarrying(true);
    await onCarry();
    setCarrying(false);
  };

  const renderTask = (t: Task) => {
    const temp = t.id < 0;
    return (
      <li key={t.id} className={cx('day-task', t.done && 'is-done', temp && 'is-temp')}>
        <button
          type="button"
          role="checkbox"
          aria-checked={t.done}
          aria-label={t.title}
          className="day-check"
          disabled={temp}
          onClick={() => onToggle(t.id, !t.done)}
        >
          <span className="day-check-box" aria-hidden="true">
            {t.done && <Icon name="check" size={14} />}
          </span>
        </button>
        <button
          type="button"
          className="day-task-title"
          disabled={temp}
          aria-label={`Izmeni: ${t.title}`}
          onClick={() => onOpen(t)}
        >
          {/* Mesto za tačku uvek postoji, da naslovi bez kategorije počinju u istoj liniji. */}
          <CategoryDot color={t.categoryId != null ? categoryColor(catMap, t.categoryId) : 'transparent'} />
          <span className="day-task-text">{t.title}</span>
        </button>
      </li>
    );
  };

  return (
    <Card
      title="Zadaci"
      className="day-tasks"
      actions={
        tasks.length > 0 ? (
          <span className="day-card-count tabular" aria-label={`Završeno ${done.length} od ${tasks.length}`}>
            {done.length} / {tasks.length}
          </span>
        ) : undefined
      }
    >
      {showCarry && openBefore > 0 && (
        <div className="day-carry">
          <p>
            Imaš {openBefore}{' '}
            {plural(openBefore, 'nezavršen zadatak', 'nezavršena zadatka', 'nezavršenih zadataka')} od ranije.
          </p>
          <Button onClick={carry} loading={carrying}>
            Prebaci u danas
          </Button>
        </div>
      )}

      <form className="day-task-add" onSubmit={submit}>
        <TextInput
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Dodaj zadatak"
          aria-label="Novi zadatak"
          maxLength={300}
          enterKeyHint="enter"
          autoComplete="off"
        />
        <IconButton icon="plus" label="Dodaj zadatak" type="submit" variant="secondary" />
      </form>

      {tasks.length === 0 ? (
        <p className="day-empty-line">Nema zadataka za ovaj dan.</p>
      ) : (
        <ul className="day-task-list">
          {open.map(renderTask)}
          {done.map(renderTask)}
        </ul>
      )}
    </Card>
  );
}
