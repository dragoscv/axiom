'use client';
import { useState, useEffect } from 'react';

interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

export default function NotesPage() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('http://localhost:4000/notes')
      .then(res => res.json())
      .then(data => {
        setNotes(data.notes || []);
        setLoading(false);
      })
      .catch(err => {
        console.error('Failed to load notes:', err);
        setLoading(false);
      });
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await fetch(`http://localhost:4000/notes/${id}`, { method: 'DELETE' });
      setNotes(notes.filter(n => n.id !== id));
    } catch (err) {
      console.error('Failed to delete note:', err);
    }
  };

  if (loading) return <div>Loading notes...</div>;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <h1>Notes</h1>
        <a href="/notes/new" style={{ 
          background: '#0070f3', 
          color: 'white', 
          padding: '0.5rem 1rem', 
          borderRadius: '4px', 
          textDecoration: 'none'
        }}>
          Create Note
        </a>
      </div>
      {notes.length === 0 ? (
        <p>No notes yet. Create your first note!</p>
      ) : (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {notes.map(note => (
            <div key={note.id} style={{ 
              border: '1px solid #ddd', 
              borderRadius: '8px', 
              padding: '1rem'
            }}>
              <h3 style={{ margin: '0 0 0.5rem 0' }}>{note.title}</h3>
              <p style={{ color: '#666', margin: '0 0 1rem 0' }}>{note.content}</p>
              <div style={{ display: 'flex', gap: '0.5rem', fontSize: '0.875rem' }}>
                <a href={`/notes/${note.id}`} style={{ color: '#0070f3' }}>View</a>
                <button onClick={() => handleDelete(note.id)} style={{ 
                  background: 'none', 
                  border: 'none', 
                  color: '#f00', 
                  cursor: 'pointer',
                  padding: 0
                }}>
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
