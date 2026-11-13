/**
 * Where the Tablamigo Host's community starter plans meet (lib/starter-plans.ts): a short, hand-picked list, reviewed by the
 * owner before STARTER_PLANS is switched on. Only public places (promenades, parks, squares, market streets), never a
 * business, and the plan's description says the exact spot is agreed in the group chat.
 *
 * Cities: the four Indian city guides (migration 029), whose guides already name these areas. A city's key is its canonical
 * city chat key (lib/city-chats.ts, scripts/seed-founder-city-chats.ts CITIES), and its centre is the guide's point. Each
 * venue's point was looked up once on Photon (lib/geo.ts placeNear, OpenStreetMap) on 13 Oct 2026 and is written out here:
 * nothing is geocoded at run time. city_tips (unvetted user tips without coordinates) is not used for venues.
 */
export type Venue = { name: string; lat: number; lng: number };
export type VenueKind = 'cafe' | 'sunset' | 'chai';
export type StarterCity = {
  /** Canonical city chat key, also starter_plans.city_key. */
  key: string;
  /** Shown in messages and stored as activities.city. */
  city: string;
  lat: number; lng: number;
  venues: Record<VenueKind, Venue>;
};

export const STARTER_CITIES: StarterCity[] = [
  {
    key: 'mumbai-in', city: 'Mumbai', lat: 19.0760, lng: 72.8777,
    venues: {
      cafe: { name: 'Kala Ghoda, Fort', lat: 18.92846, lng: 72.83260 },
      sunset: { name: 'Marine Drive promenade', lat: 18.94994, lng: 72.81880 },
      chai: { name: 'Carter Road Promenade, Bandra', lat: 19.06654, lng: 72.82282 },
    },
  },
  {
    key: 'goa-in', city: 'Goa', lat: 15.4909, lng: 73.8278,
    venues: {
      cafe: { name: 'Fontainhas, Panaji', lat: 15.49666, lng: 73.83108 },
      sunset: { name: 'Miramar Beach, Panaji', lat: 15.47668, lng: 73.80668 },
      chai: { name: 'Church Square, Panaji', lat: 15.49870, lng: 73.82836 },
    },
  },
  {
    key: 'delhi-in', city: 'Delhi', lat: 28.6139, lng: 77.2090,
    venues: {
      cafe: { name: 'Khan Market', lat: 28.60014, lng: 77.22649 },
      sunset: { name: 'Lodhi Garden', lat: 28.59362, lng: 77.22014 },
      chai: { name: 'Central Park, Connaught Place', lat: 28.63280, lng: 77.21971 },
    },
  },
  {
    key: 'bangalore-in', city: 'Bangalore', lat: 12.9716, lng: 77.5946,
    venues: {
      cafe: { name: 'Church Street', lat: 12.97549, lng: 77.60268 },
      sunset: { name: 'Cubbon Park', lat: 12.97425, lng: 77.59219 },
      chai: { name: '100 Feet Road, Indiranagar', lat: 12.97023, lng: 77.64133 },
    },
  },
];
