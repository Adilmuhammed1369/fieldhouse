import { useState } from 'react'
import './App.css'

function App() {
  const [bookingMessage, setBookingMessage] = useState('')
  const [menuOpen, setMenuOpen] = useState(false)

  const handleSearch = (event) => {
    event.preventDefault()
    setBookingMessage('Great choice. Showing available pitches for your search.')
  }

  return (
    <main>
      <section className="hero" id="home">
        <nav className="nav shell"><a className="brand" href="#home" aria-label="Fieldhouse home"><span className="brand-mark">F</span><span>fieldhouse</span></a><button className="menu-toggle" type="button" onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle navigation">Menu</button><div className={`nav-links ${menuOpen ? 'is-open' : ''}`}><a href="#pitches" onClick={() => setMenuOpen(false)}>Find a pitch</a><a href="#how-it-works" onClick={() => setMenuOpen(false)}>How it works</a><a href="#community" onClick={() => setMenuOpen(false)}>Community</a><a className="nav-login" href="#footer" onClick={() => setMenuOpen(false)}>Log in <span aria-hidden="true">↗</span></a></div></nav>
        <div className="hero-content shell"><p className="eyebrow">THE HOME OF YOUR GAME <span></span> EST. 2018</p><h1>Your next<br /><em>match</em> starts here.</h1><p className="hero-copy">Premium pitches. Easy booking.<br />More time playing the game you love.</p><a className="round-arrow" href="#pitches" aria-label="Explore pitches">↘</a></div><div className="hero-stamp">BUILT FOR<br /><strong>PLAYERS</strong><br />BY PLAYERS</div><div className="hero-bottom shell"><span>SCROLL TO EXPLORE</span><span className="scroll-line"></span><span>01 — 04</span></div>
      </section>
      <section className="booking-section shell" id="pitches"><div className="section-heading reveal"><p className="eyebrow dark">BOOK YOUR PLAY</p><h2>Find your<br /><em>perfect pitch.</em></h2></div><form className="booking-form reveal" onSubmit={handleSearch}><label>Where <select defaultValue="London"><option>London</option><option>Manchester</option><option>Bristol</option></select></label><label>When <select defaultValue="This weekend"><option>This weekend</option><option>Today</option><option>Next week</option></select></label><label>Game <select defaultValue="5-a-side football"><option>5-a-side football</option><option>7-a-side football</option><option>Padel</option></select></label><button type="submit" className="search-button">Search pitches <span>→</span></button>{bookingMessage && <p className="booking-message" role="status">{bookingMessage}</p>}</form></section>
      <section className="feature-section" id="how-it-works"><div className="feature-image"></div><div className="feature-copy reveal"><p className="eyebrow dark">MORE THAN A PITCH</p><h2>Come for the<br /><em>game.</em> Stay for<br />the feeling.</h2><p>From the first whistle to the last high five, Fieldhouse makes every game day feel like the main event.</p><a className="text-link" href="#community">Discover Fieldhouse <span>↗</span></a></div></section>
      <section className="numbers-section shell" id="community"><div className="numbers-intro reveal"><p className="eyebrow dark">THE FIELDHOUSE STANDARD</p><h2>Made for<br /><em>the beautiful game.</em></h2></div><div className="stat-grid"><div className="stat reveal"><strong>14</strong><span>PREMIUM<br />LOCATIONS</span></div><div className="stat reveal"><strong>4.9</strong><span>PLAYER<br />RATING</span></div><div className="stat reveal"><strong>38k</strong><span>GAMES PLAYED<br />THIS YEAR</span></div></div></section>
      <footer className="footer shell" id="footer"><a className="brand" href="#home"><span className="brand-mark">F</span><span>fieldhouse</span></a><p>Keep playing.<br />Keep moving.</p><span className="footer-note">© 2024 FIELDHOUSE</span></footer>
    </main>
  )
}

export default App
