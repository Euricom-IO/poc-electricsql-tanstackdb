import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useLiveQuery } from '@tanstack/react-db';
import { Trash2 } from 'lucide-react';
import { todoCollection, type Todo } from '@/collections/todos';
import { auth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export const Route = createFileRoute('/_authed/todos')({
  component: TodosPage,
});

function TodosPage() {
  const { data } = useLiveQuery((q) => q.from({ todo: todoCollection }));
  const [title, setTitle] = useState('');

  const todos = [...(data ?? [])].sort(
    (a, b) => b.created_at.getTime() - a.created_at.getTime(),
  );

  function addTodo(e: React.FormEvent) {
    e.preventDefault();
    const value = title.trim();
    if (!value) return;
    // Insert uses raw SQLite-compatible values (integer/text); the collection
    // schema transforms them back into boolean/Date when the row is read.
    todoCollection.insert({
      id: crypto.randomUUID(),
      user_id: auth.user?.id ?? '',
      title: value,
      completed: 0,
      created_at: new Date().toISOString(),
    });
    setTitle('');
  }

  function toggle(todo: Todo) {
    // The update draft holds raw SQLite values, so `completed` is an integer.
    todoCollection.update(todo.id, (draft) => {
      draft.completed = todo.completed ? 0 : 1;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>My todos</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <form onSubmit={addTodo} className="flex gap-2">
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs doing?"
          />
          <Button type="submit">Add</Button>
        </form>

        <ul className="flex flex-col divide-y">
          {todos.length === 0 && (
            <li className="py-6 text-center text-sm text-muted-foreground">No todos yet.</li>
          )}
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-center gap-3 py-2.5">
              <input
                type="checkbox"
                checked={todo.completed}
                onChange={() => toggle(todo)}
                className="size-4 accent-primary"
              />
              <span
                className={
                  todo.completed ? 'flex-1 text-muted-foreground line-through' : 'flex-1'
                }
              >
                {todo.title}
              </span>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => todoCollection.delete(todo.id)}
                aria-label="Delete todo"
              >
                <Trash2 className="size-4 text-destructive" />
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
