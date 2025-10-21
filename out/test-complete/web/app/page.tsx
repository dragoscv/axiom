export default function HomePage() {
  return (
    <div>
      <h1>TEST-COMPLETE</h1>
      <p>Welcome to your AXIOM-generated application.</p>
      <div style={{ marginTop: '2rem' }}>
        <a href="/notes" style={{ 
          background: '#0070f3', 
          color: 'white', 
          padding: '0.5rem 1rem', 
          borderRadius: '4px', 
          textDecoration: 'none',
          display: 'inline-block'
        }}>
          View Notes
        </a>
      </div>
    </div>
  );
}
