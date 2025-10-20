'use client';
import { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

export default function NoteDetailPage() {
  const params = useParams();
  const router = useRouter();
  const [note, setNote] = useState<Note | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`http://localhost:4000/notes/${params.id}`)
      .then(res => res.json())
      .then(data => {
        setNote(data);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load note:', err);
        setLoading(false);
      });
  }, [params.id]);

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this note?')) return;
    try {
      await fetch(`http://localhost:4000/notes/${params.id}`, { method: 'DELETE' });
      router.push('/notes');
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (!note) return <div>Note not found</div>;

  return (
    <div>
      <div style={{ marginBottom: '2rem' }}>
        <a href="/notes" style={{ color: '#0070f3', textDecoration: 'none' }}>← Back to Notes</a>
      </div>
      <article style={{ maxWidth: '800px' }}>
        <h1>{note.title}</h1>
        <p style={{ color: '#666', fontSize: '0.875rem' }}>
          Created: {new Date(note.createdAt).toLocaleDateString()}
        </p>
        <div style={{ 
          marginTop: '2rem', 
          padding: '1rem', 
          background: '#f9f9f9', 
          borderRadius: '8px',
          whiteSpace: 'pre-wrap'
        }}>
          {note.content}
        </div>
        <div style={{ marginTop: '2rem', display: 'flex', gap: '0.5rem' }}>
          <button onClick={handleDelete} style={{ 
            background: '#f00', 
            color: 'white', 
            padding: '0.5rem 1rem', 
            borderRadius: '4px',
            border: 'none',
            cursor: 'pointer'
          }}>
            Delete Note
          </button>
        </div>
      </article>
    </div>
  );
}
