import { useState } from "react";
import EventCard from "../components/EventCard";
import { useAuth } from "../context/useAuth";

function Events({ events = [], loading = false, error = "", onBook, onOpenAdmin, onEdit }) {
  const { isAdmin } = useAuth();
  const [search, setSearch] = useState("");

  // Only show events that have available tickets in the backend inventory
  const availableEvents = events.filter((event) => Number(event.available) > 0);

  const filteredEvents = availableEvents.filter((event) => {
    const q = search.toLowerCase();
    return (
      (event.name && event.name.toLowerCase().includes(q)) ||
      (event.id && event.id.toLowerCase().includes(q)) ||
      (event.location && event.location.toLowerCase().includes(q)) ||
      (event.category && event.category.toLowerCase().includes(q))
    );
  });

  return (
    <>
      <header className="hero">
        <div className="hero-content">
          <span className="hero-kicker">Live Available Tickets</span>
          <h1 className="hero-title">Browse verified live events.</h1>
          <p className="hero-subtitle">
            Only verified tickets with real-time backend inventory availability are displayed.
          </p>

          <div className="hero-search-wrap">
            <span className="search-icon" aria-hidden="true">🔍</span>
            <input
              type="text"
              className="hero-search-input"
              placeholder="Search by event title, ID, genre, or city..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label="Search events"
            />
            {search && (
              <button
                type="button"
                className="clear-search-btn"
                onClick={() => setSearch("")}
                aria-label="Clear search"
              >
                &times;
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="main-content">
        <div className="section-heading">
          <div>
            <h2>Available Tickets</h2>
            <span className="section-subtitle">Real-time Redis inventory stream</span>
          </div>

          <div className="heading-actions">
            {isAdmin && onOpenAdmin && (
              <button
                type="button"
                className="admin-quick-add-btn"
                onClick={onOpenAdmin}
              >
                + Add Tickets
              </button>
            )}
            <span className="count-pill">
              {filteredEvents.length} {filteredEvents.length === 1 ? "event" : "events"} available
            </span>
          </div>
        </div>

        {loading ? (
          <div className="event-grid" aria-busy="true" aria-label="Loading events">
            {Array.from({ length: 6 }, (_, i) => (
              <div className="skeleton-card" key={i} style={{ "--i": i }} aria-hidden="true">
                <div className="skeleton-line chip" />
                <div className="skeleton-line title" />
                <div className="skeleton-line" />
                <div className="skeleton-line short" />
                <div className="skeleton-line footer" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="empty-search-state error">
            <p className="empty-message">⚠️ {error}</p>
          </div>
        ) : filteredEvents.length > 0 ? (
          <div className="event-grid">
            {filteredEvents.map((event, index) => (
              <EventCard
                key={event.id || event.eventId}
                index={index}
                event={event}
                onBook={onBook}
                onEdit={onEdit}
              />
            ))}
          </div>
        ) : search ? (
          <div className="empty-search-state">
            <p className="empty-message">No available tickets matching "{search}".</p>
            <button
              type="button"
              className="secondary-btn"
              onClick={() => setSearch("")}
            >
              Clear Search
            </button>
          </div>
        ) : (
          <div className="empty-search-state">
            <div className="empty-state-icon">🎟️</div>
            <p className="empty-message empty-title">
              No tickets currently available in inventory
            </p>
            <p className="empty-hint">
              {isAdmin
                ? "As an administrator, click '+ Add Tickets' to initialize event tickets into the backend Redis cache."
                : "All tickets are currently reserved or waiting for release. Check back soon!"}
            </p>
            {isAdmin && onOpenAdmin && (
              <button
                type="button"
                className="primary-btn"
                onClick={onOpenAdmin}
              >
                + Add Tickets to Inventory
              </button>
            )}
          </div>
        )}
      </main>
    </>
  );
}

export default Events;
