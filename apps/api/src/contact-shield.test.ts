// Contact-detail detector: evasions it must catch and everyday travel talk it must let through. No database.
import { describe, it, expect } from 'vitest';
import { findContact } from './lib/contact-shield.js';

const kind = (text: string, recent?: string[]) => findContact(text, recent)?.kind ?? null;

describe('contact shield: catches', () => {
  it.each([
    'call me 9876543210',
    '+91 98765 43210',
    '98765-43210',
    '987.654.3210',
    '(987) 654-3210',
    '9 8 7 6 5 4 3 2 1 0',
    '98 76 54 32 10',
    'nine eight seven six five four three two one zero',
    'Nine 8 seven 6 five 4 three 2 one 0',
    'nine eight double seven six five four three two one',
    'nine-eight-seven-six-five-four-three-two-one-zero',
    '9️⃣8️⃣7️⃣6️⃣5️⃣4️⃣3️⃣2️⃣1️⃣0️⃣',
    '９８７６５４３２１０',
    '९८७६५४३२१०',
    'my num 98765 4321O',
    'O98765432l0',
    '06.12.34.56.78',
    '+44 7700 900123',
    '+65 9123 4567',
    'my number is 98765 43210, text me',
    'whatsapp: 98765 43210',
    'call 1 800 123 4567',
    'the number is 98 7 65 4 32 10 ok',
    '98765/43210',
    '98765\u200b43210', // zero-width space
  ])('phone: %s', t => expect(kind(t)).toBe('phone'));

  it.each([
    'maria.k@gmail.com',
    'Maria.K@Company.co.uk',
    'maria at gmail dot com',
    'maria(at)gmail(dot)com',
    'maria [at] gmail [dot] com',
    'maria @ gmail . com',
    'maria@gmail',
    'maria {at} outlook {dot} com',
  ])('email: %s', t => expect(kind(t)).toBe('email'));

  it.each([
    'insta: maria.travels',
    'Insta - @maria',
    'ig @maria_k',
    'my insta is maria_92',
    'insta id mariatravels',
    'add me on insta mariatravels',
    'follow me on ig @maria',
    'find me on telegram: mariak',
    'i n s t a: maria',
    'w h a t s a p p: mariak',
    'wh4tsapp: mariak',
    '1nsta: mariak',
    'telegram @maria_k',
    'snap: mariak',
    'tg -> mariak',
    'hit me up on snap mariak',
    '@maria.travels',
    'message me @maria_92',
  ])('handle: %s', t => expect(kind(t)).toBe('handle'));

  it.each([
    'wa.me/919876543210',
    'https://t.me/mariak',
    'instagram.com/maria',
    'join chat.whatsapp.com/AbCdEf',
    't dot me/mariak',
    'https://www.instagram.com/maria.travels/',
  ])('link: %s', t => expect(['link', 'phone']).toContain(kind(t)));

  it('a number sent a few digits per message', () => {
    expect(kind('43210', ['my number', '98765'])).toBe('phone');
    expect(kind('3210', ['98', '765', '4'])).toBe('phone');
  });
});

describe('contact shield: lets through', () => {
  it.each([
    '2 people',
    'Table for 4 at 8pm',
    'Dinner at 7, 2 of us, 3 hours max',
    "It's ₹1,500 per person",
    '₹1500-2000 each',
    '$20-30 for dinner',
    'Budget 1500-2000 baht',
    'beer 80 baht, pad thai 60 baht',
    'Tickets are 2500 INR',
    'Meet 10:30 - 12:30',
    '10.30-12.30 works',
    '10.30am to 12.30pm',
    'from 12/10/2026 to 15/10/2026',
    '12/10/2026 - 15/10/2026',
    '12.10.2026 - 15.10.2026',
    'arriving 2026-10-12',
    'Oct 12 - 15, 2026',
    '2025 2026 were great years',
    'Flight EK 512 lands 14.35',
    'Train 12951 leaves 16:35',
    'Room 1203, 12th floor',
    "I'm 28, been to 14 countries",
    '4.5 stars, 1200 reviews',
    'Pin: 13.7466 100.5346',
    'Price ₹ 2,49,999',
    'dinner sets 1500 2000 2500',
    'hostel: 12 Soi 4, Sukhumvit 11, Bangkok 10110',
    'gate 12 seat 34A row 5',
    'one or two drinks, then maybe three bars',
    'one two three go!',
    'Call me when you land',
    'text me later, whatsapp is down lol',
    'I love insta photos',
    'my insta is broken',
    'Meet @starbucks at 7',
    'drinks @7pm?',
    'see you at the gate at 9',
    'the 5 of us, at 9, plaza 3',
    'Oh nice! Oh one more thing',
    'Is the email from the hostel legit?',
    'google maps link: https://maps.app.goo.gl/abc123',
    'check https://www.lonelyplanet.com/thailand',
    'I got 10/10 on the quiz, 9.5 last time',
  ])('%s', t => expect(findContact(t)).toBeNull());

  it('short numbers across messages stay fine', () => {
    expect(kind('at 8', ['Table for 4', 'around 7:30?'])).toBeNull();
    expect(kind('3 of us', ['2 people', '10:30 - 12:30'])).toBeNull();
  });
});
