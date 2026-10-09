import { useMemo, useRef, useState, type FormEvent } from 'react';
import type { Category, DayPayload, Task } from '../../../../shared/types.ts';
import { useT } from '../../i18n/index.ts';
import { categoryColor } from '../../lib/store.ts';
import { Button, Card, CategoryDot, Icon, IconButton, TextInput, cx } from '../../ui/index.ts';

/** Nezavršeni po redosledu, pa završeni po vremenu završetka (isto kao server). */
function orderTasks(tasks: Task[]): { open: Task[]; done: Task[] } {
  const open = tasks.filter((x) => !x.done).sort((a, b) => a.sort - b.sort || a.id - b.id);
  const done = tasks
    .filter((x) => x.done)
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
  const t = useT();
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

  const renderTask = (task: Task) => {
    const temp = task.id < 0;
    return (
      <li key={task.id} className={cx('day-task', task.done && 'is-done', temp && 'is-temp')}>
        <button
          type="button"
          role="checkbox"
          aria-checked={task.done}
          aria-label={task.title}
          className="day-check"
          disabled={temp}
          onClick={() => onToggle(task.id, !task.done)}
        >
          <span className="day-check-box" aria-hidden="true">
            {task.done && <Icon name="check" size={14} />}
          </span>
        </button>
        <button
          type="button"
          className="day-task-title"
          disabled={temp}
          aria-label={t('tasks.editAria', { title: task.title })}
          onClick={() => onOpen(task)}
        >
          {/* Mesto za tačku uvek postoji, da naslovi bez kategorije počinju u istoj liniji. */}
          <CategoryDot color={task.categoryId != null ? categoryColor(catMap, task.categoryId) : 'transparent'} />
          <span className="day-task-text">{task.title}</span>
        </button>
      </li>
    );
  };

  return (
    <Card
      title={t('tasks.title')}
      className="day-tasks"
      actions={
        tasks.length > 0 ? (
          <span
            className="day-card-count tabular"
            aria-label={t('tasks.countAria', { done: done.length, total: tasks.length })}
          >
            {done.length} / {tasks.length}
          </span>
        ) : undefined
      }
    >
      {showCarry && openBefore > 0 && (
        <div className="day-carry">
          <p>{t('tasks.carry.text', { n: openBefore })}</p>
          <Button onClick={carry} loading={carrying}>
            {t('tasks.carry.action')}
          </Button>
        </div>
      )}

      <form className="day-task-add" onSubmit={submit}>
        <TextInput
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('tasks.add.placeholder')}
          aria-label={t('tasks.add.aria')}
          maxLength={300}
          enterKeyHint="enter"
          autoComplete="off"
        />
        <IconButton icon="plus" label={t('tasks.add.button')} type="submit" variant="secondary" />
      </form>

      {tasks.length === 0 ? (
        <p className="day-empty-line">{t('tasks.empty')}</p>
      ) : (
        <ul className="day-task-list">
          {open.map(renderTask)}
          {done.map(renderTask)}
        </ul>
      )}
    </Card>
  );
}
