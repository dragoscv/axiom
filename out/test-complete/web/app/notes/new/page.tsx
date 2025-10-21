'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function NewNotePage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const res = await fetch('http://localhost:4000/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content })
      });
      if (res.ok) {
        router.push('/notes');
      }
    } catch (err) {
      console.error('Failed to create note:', err);
      setSaving(false);
    }
  };

  return (
    <div>
      <h1>Create New Note</h1>
      <form onSubmit={handleSubmit} style={{ maxWidth: '600px' }}>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
            Title
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            required
            style={{ 
              width: '100%', 
              padding: '0.5rem', 
              fontSize: '1rem',
              border: '1px solid #ddd',
              borderRadius: '4px'
            }}
          />
        </div>
        <div style={{ marginBottom: '1rem' }}>
          <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 'bold' }}>
            Content
          </label>
          <textarea
            value={content}
            onChange={e => setContent(e.target.value)}
            required
            rows={6}
            style={{ 
              width: '100%', 
              padding: '0.5rem', 
              fontSize: '1rem',
              border: '1px solid #ddd',
              borderRadius: '4px',
              fontFamily: 'inherit'
            }}
          />
        </div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button
            type="submit"
            disabled={saving}
            style={{ 
              background: '#0070f3', 
              color: 'white', 
              padding: '0.5rem 1rem', 
              borderRadius: '4px',
              border: 'none',
              cursor: saving ? 'not-allowed' : 'pointer',
              fontSize: '1rem'
            }}
          >
            {saving ? 'Saving...' : 'Create Note'}
          </button>
          <a href="/notes" style={{ 
            padding: '0.5rem 1rem', 
            borderRadius: '4px',
            border: '1px solid #ddd',
            textDecoration: 'none',
            color: '#333',
            display: 'inline-block'
          }}>
            Cancel
          </a>
        </div>
      </form>
    </div>
  );
}
