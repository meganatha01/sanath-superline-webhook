// Sanath Superline Chatbot - Dialogflow Webhook Fulfillment (Vercel version)
// This file must live at: api/webhook.js
// Deployed URL: https://YOUR-PROJECT.vercel.app/api/webhook

const { WebhookClient } = require('dialogflow-fulfillment');
const routesData = require('../routes-data.json');

const CONTEXT_NAME = 'city-context';
const CONTEXT_LIFESPAN = 5;

// Used when someone wants to go TO Colombo but hasn't said where they
// currently are. We ask "where are you now?" and park the original
// request here until the next message supplies an origin city.
const AWAITING_ORIGIN_CONTEXT = 'awaiting-origin';
const AWAITING_ORIGIN_LIFESPAN = 2;

// Every context this webhook creates. When a conversation ends (a
// "thanks" / "bye" signal) we clear all of these so the next
// enquiry starts fresh with no stale origin / destination bleeding in.
const ALL_CONTEXTS = [CONTEXT_NAME, AWAITING_ORIGIN_CONTEXT];

function getCityData(cityParam) {
  if (!cityParam) return null;
  const key = String(cityParam).toLowerCase().trim();
  return routesData[key] || null;
}

// Handles both directions of travel. Normal case: Colombo -> some city,
// looked up directly by that city's name. Reverse case: some city -> Colombo,
// where "colombo" itself isn't a key in routes-data.json (it's the hub, not
// a destination) - so we reuse the OTHER city's entry instead, since buses
// run the same hourly schedule/fare/road both ways.
function getRouteData(destination, origin) {
  const destKey = String(destination || '').toLowerCase().trim();
  const originKey = String(origin || '').toLowerCase().trim();

  if (routesData[destKey]) {
    return { data: routesData[destKey], reversed: false };
  }
  if (destKey === 'colombo' && routesData[originKey]) {
    return { data: routesData[originKey], reversed: true };
  }
  return null;
}

function listKnownCities() {
  return Object.keys(routesData)
    .map(c => c.charAt(0).toUpperCase() + c.slice(1))
    .join(', ');
}

// Reads destination from the current request parameters, and if missing,
// falls back to whatever city was last discussed (via context) - this is
// what lets "what time does it leave" work without repeating the city name.
function resolveDestination(agent) {
  let destination = agent.parameters.destination;
  if (!destination) {
    const ctx = agent.context.get(CONTEXT_NAME);
    if (ctx && ctx.parameters && ctx.parameters.destination) {
      destination = ctx.parameters.destination;
    }
  }
  return destination;
}

// Reads origin from the current utterance's parameters, or from the
// remembered context if the user is continuing the same trip.
//
// Tricky detail: the `origin` parameter has a Default Value of
// `#city-context.origin` in Dialogflow, so `agent.parameters.origin`
// is silently pre-filled with the remembered origin even when the
// user didn't actually say it in this utterance. We can't just trust
// the param at face value - instead we check whether the origin word
// appears in the raw query text. If it does, the user really said it.
// If not, it was auto-filled from context and we treat it as potentially
// stale (see detectDestinationPivot).
function resolveOrigin(agent, resolvedDestination) {
  const paramOrigin = agent.parameters.origin;
  const queryText = String(agent.query || '').toLowerCase();
  const userActuallyTypedOrigin =
    paramOrigin && queryText.includes(String(paramOrigin).toLowerCase());

  if (userActuallyTypedOrigin) {
    return paramOrigin;
  }

  // Fresh new destination + no explicit origin typed = passenger has
  // pivoted to a new trip, so drop any stale origin and default to Colombo.
  if (detectDestinationPivot(agent, resolvedDestination)) {
    return 'Colombo';
  }

  const ctx = agent.context.get(CONTEXT_NAME);
  const rememberedOrigin = ctx && ctx.parameters && ctx.parameters.origin;
  return paramOrigin || rememberedOrigin || 'Colombo';
}

// True when the user has just named a brand-new destination different
// from the one we last remembered (a "pivot"). Returns false when it's
// the same destination (a follow-up on the same trip) or when there
// was no previous destination.
function detectDestinationPivot(agent, resolvedDestination) {
  const ctx = agent.context.get(CONTEXT_NAME);
  const previousDestination = ctx && ctx.parameters && ctx.parameters.destination;
  if (!previousDestination || !resolvedDestination) return false;
  return (
    String(previousDestination).toLowerCase().trim() !==
    String(resolvedDestination).toLowerCase().trim()
  );
}

// Wipes every context this webhook manages. Called at the end of a
// conversation (thanks / bye) so the next enquiry starts clean.
function clearMemory(agent) {
  ALL_CONTEXTS.forEach(name => {
    agent.context.set({ name, lifespan: 0 });
  });
}

// Call this at the end of every enquiry handler so the city is
// remembered for the next message in the conversation.
function rememberCity(agent, destination, origin) {
  agent.context.set({
    name: CONTEXT_NAME,
    lifespan: CONTEXT_LIFESPAN,
    parameters: { destination, origin: origin || 'Colombo' },
  });
}

// True when the destination is Colombo and no real origin was ever given -
// resolveOrigin() silently defaults missing origin to 'Colombo' too, which
// otherwise produces a confusing "don't have info for Colombo" reply for a
// city we obviously know. This is the case where we should ask a
// clarifying question instead of failing.
function isSelfReferentialColombo(destination, origin) {
  const destKey = String(destination || '').toLowerCase().trim();
  const originKey = String(origin || '').toLowerCase().trim();
  return destKey === 'colombo' && originKey === 'colombo';
}

// Ask "where are you now?" and remember what the person actually wanted
// (route / timetable / fare / busType / roadType, plus any busType they
// already named) so origin.provided() can give the right kind of answer
// once they reply with a city.
function askForOrigin(agent, pendingIntent, busType) {
  agent.add(`Colombo is our main hub! Where are you travelling from?`);

  agent.context.set({
    name: AWAITING_ORIGIN_CONTEXT,
    lifespan: AWAITING_ORIGIN_LIFESPAN,
    parameters: { pendingIntent, pendingBusType: busType || '' },
  });

  // Remember that Colombo is the destination so city-context stays useful
  // even though we don't have the origin yet.
  agent.context.set({
    name: CONTEXT_NAME,
    lifespan: CONTEXT_LIFESPAN,
    parameters: { destination: 'Colombo', origin: '' },
  });
}

// Handles the reply to "where are you now?" - builds a full answer
// (distance, journey time, road type, bus types and fares) tailored to
// whichever enquiry the person originally made.
function originProvided(agent) {
  const ctx = agent.context.get(AWAITING_ORIGIN_CONTEXT);
  const pendingIntent = (ctx && ctx.parameters && ctx.parameters.pendingIntent) || 'route';
  const pendingBusType = (ctx && ctx.parameters && ctx.parameters.pendingBusType) || agent.parameters.busType;

  const origin = agent.parameters.origin || agent.parameters['city-context.origin'] || agent.parameters.city;
  const destination = 'Colombo';
  const result = getRouteData(destination, origin);

  if (!origin || !result) {
    agent.add(`Sorry, I don't recognise that city. Could you tell me which city you're travelling from?`);
    return;
  }
  const { data } = result;

  // Always lead with the basics, then add detail matching what was asked.
  agent.add(`Got it! Here's Colombo travel info from ${origin}:`);
  agent.add(`Distance: ${data.distanceKm} km  |  Journey time: ~${data.durationHours} hrs  |  Road: ${data.roadType}`);

  if (pendingIntent === 'timetable') {
    data.busTypes.forEach(bus => {
      agent.add(`${bus.type}: ${bus.departureTimes.join(', ')}`);
    });
  } else if (pendingIntent === 'fare' || pendingIntent === 'busType') {
    if (pendingBusType) {
      const match = data.busTypes.find(
        b => b.type.toLowerCase() === String(pendingBusType).toLowerCase()
      );
      if (match) {
        agent.add(`${match.type}: departs ${match.departureTimes.join(', ')} - Rs. ${match.fare}`);
      }
    } else {
      data.busTypes.forEach(bus => {
        agent.add(`${bus.type} - departs ${bus.departureTimes.join(', ')} - Rs. ${bus.fare}`);
      });
    }
  } else if (pendingIntent === 'roadType') {
    // Road type already included above; nothing extra to add.
  } else {
    // route (default): give the general overview, same as routeEnquiry.
    agent.add(`Bus types available: ${data.busTypes.map(b => b.type).join(', ')}`);
    agent.add(`Would you like the timetable or fares?`);
  }

  rememberCity(agent, destination, origin);
}

// Ends the conversation warmly and wipes all memory so the next
// enquiry starts fresh. Wired to smalltalk.thanks in intentMap.
function thanks(agent) {
  const responses = [
    `You're welcome! Safe travels, and ask anytime.`,
    `Anytime! Have a great journey. I'm here if you need me again.`,
    `Happy to help! Safe travels, and feel free to ask again anytime.`,
  ];
  agent.add(responses[Math.floor(Math.random() * responses.length)]);
  clearMemory(agent);
}

function routeEnquiry(agent) {
  const destination = resolveDestination(agent);
  const isPivot = detectDestinationPivot(agent, destination);
  const origin = resolveOrigin(agent, destination);

  if (isSelfReferentialColombo(destination, origin)) {
    askForOrigin(agent, 'route');
    return;
  }

  const result = getRouteData(destination, origin);

  if (!result) {
    agent.add(`Sorry, I don't have route information for "${destination}" yet.`);
    agent.add(`We currently cover Colombo to: ${listKnownCities()}.`);
    return;
  }
  const { data } = result;

  if (isPivot) {
    agent.add(`Sure, switching to ${destination}. Here are the details.`);
  }
  agent.add(`Yes! Sanath Superline runs buses from ${origin} to ${destination}.`);
  agent.add(`Distance: ${data.distanceKm} km  |  Journey time: ~${data.durationHours} hrs  |  Road: ${data.roadType}`);
  agent.add(`Bus types available: ${data.busTypes.map(b => b.type).join(', ')}`);
  agent.add(`Would you like the timetable or fares?`);

  rememberCity(agent, destination, origin);
}

function timetableEnquiry(agent) {
  const destination = resolveDestination(agent);
  const isPivot = detectDestinationPivot(agent, destination);
  const origin = resolveOrigin(agent, destination);

  if (isSelfReferentialColombo(destination, origin)) {
    askForOrigin(agent, 'timetable');
    return;
  }

  const result = getRouteData(destination, origin);

  if (!result) {
    agent.add(`Sorry, I don't have timetable information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
  }
  const { data } = result;

  if (isPivot) {
    agent.add(`Sure, switching to ${destination}.`);
  }
  agent.add(`Here's the timetable from ${origin} to ${destination}:`);
  data.busTypes.forEach(bus => {
    agent.add(`${bus.type}: ${bus.departureTimes.join(', ')}`);
  });

  rememberCity(agent, destination, origin);
}

function busTypeEnquiry(agent) {
  const destination = resolveDestination(agent);
  const isPivot = detectDestinationPivot(agent, destination);
  const origin = resolveOrigin(agent, destination);
  const busType = agent.parameters.busType;

  if (isSelfReferentialColombo(destination, origin)) {
    askForOrigin(agent, 'busType', busType);
    return;
  }

  const result = getRouteData(destination, origin);

  if (!result) {
    agent.add(`Sorry, I don't have information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
  }
  const { data } = result;

  if (isPivot) {
    agent.add(`Sure, switching to ${destination}.`);
  }
  if (busType) {
    const match = data.busTypes.find(
      b => b.type.toLowerCase() === String(busType).toLowerCase()
    );
    if (match) {
      agent.add(`Yes, we run ${match.type} buses to ${destination}.`);
      agent.add(`Departures: ${match.departureTimes.join(', ')}`);
      agent.add(`Fare: Rs. ${match.fare}`);
    } else {
      agent.add(`Sorry, we don't currently run ${busType} buses to ${destination}.`);
      agent.add(`Available types: ${data.busTypes.map(b => b.type).join(', ')}.`);
    }
  } else {
    agent.add(`Bus types available to ${destination}:`);
    data.busTypes.forEach(bus => {
      agent.add(`${bus.type} - departs ${bus.departureTimes.join(', ')} - Rs. ${bus.fare}`);
    });
  }

  rememberCity(agent, destination, origin);
}

function roadTypeEnquiry(agent) {
  const destination = resolveDestination(agent);
  const isPivot = detectDestinationPivot(agent, destination);
  const origin = resolveOrigin(agent, destination);

  if (isSelfReferentialColombo(destination, origin)) {
    askForOrigin(agent, 'roadType');
    return;
  }

  const result = getRouteData(destination, origin);

  if (!result) {
    agent.add(`Sorry, I don't have road information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
  }
  if (isPivot) {
    agent.add(`Sure, switching to ${destination}.`);
  }
  agent.add(`Buses to ${destination} travel via: ${result.data.roadType}.`);

  rememberCity(agent, destination, origin);
}

function fareEnquiry(agent) {
  const destination = resolveDestination(agent);
  const isPivot = detectDestinationPivot(agent, destination);
  const origin = resolveOrigin(agent, destination);
  const busType = agent.parameters.busType;

  if (isSelfReferentialColombo(destination, origin)) {
    askForOrigin(agent, 'fare', busType);
    return;
  }

  const result = getRouteData(destination, origin);

  if (!result) {
    agent.add(`Sorry, I don't have fare information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
  }
  const { data } = result;

  if (isPivot) {
    agent.add(`Sure, switching to ${destination}.`);
  }
  if (busType) {
    const match = data.busTypes.find(
      b => b.type.toLowerCase() === String(busType).toLowerCase()
    );
    if (match) {
      agent.add(`The fare for ${match.type} to ${destination} is Rs. ${match.fare}.`);
      rememberCity(agent, destination, origin);
      return;
    }
  }

  agent.add(`Fares to ${destination}:`);
  data.busTypes.forEach(bus => {
    agent.add(`${bus.type}: Rs. ${bus.fare}`);
  });

  rememberCity(agent, destination, origin);
}

function fallback(agent) {
  agent.add(
    `Sorry, I didn't quite catch that. You can ask me about routes, timetables, bus types, fares, or road type for any of our destinations.`
  );
}

// Vercel serverless function entry point
module.exports = (req, res) => {
  if (req.method === 'GET') {
    res.status(200).send('Sanath Superline webhook is running.');
    return;
  }

  const agent = new WebhookClient({ request: req, response: res });

  const intentMap = new Map();
  intentMap.set('route.enquiry', routeEnquiry);
  intentMap.set('timetable.enquiry', timetableEnquiry);
  intentMap.set('busType.enquiry', busTypeEnquiry);
  intentMap.set('roadType.enquiry', roadTypeEnquiry);
  intentMap.set('fare.enquiry', fareEnquiry);
  intentMap.set('origin.provided', originProvided);
  intentMap.set('smalltalk.thanks', thanks);
  intentMap.set('Default Fallback Intent', fallback);

  agent.handleRequest(intentMap);
};
