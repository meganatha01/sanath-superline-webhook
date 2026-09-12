// Sanath Superline Chatbot - Dialogflow Webhook Fulfillment (Vercel version)
// This file must live at: api/webhook.js
// Deployed URL: https://YOUR-PROJECT.vercel.app/api/webhook

const { WebhookClient } = require('dialogflow-fulfillment');
const routesData = require('../routes-data.json');

const CONTEXT_NAME = 'city-context';
const CONTEXT_LIFESPAN = 5;

function getCityData(cityParam) {
  if (!cityParam) return null;
  const key = String(cityParam).toLowerCase().trim();
  return routesData[key] || null;
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

// Call this at the end of every enquiry handler so the city is
// remembered for the next message in the conversation.
function rememberCity(agent, destination, origin) {
  agent.context.set({
    name: CONTEXT_NAME,
    lifespan: CONTEXT_LIFESPAN,
    parameters: { destination, origin: origin || 'Colombo' },
  });
}

function routeEnquiry(agent) {
  const destination = resolveDestination(agent);
  const origin = agent.parameters.origin || 'Colombo';
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have route information for "${destination}" yet.`);
    agent.add(`We currently cover Colombo to: ${listKnownCities()}.`);
    return;
  }

  agent.add(`Yes! Sanath Superline runs buses from ${origin} to ${destination}.`);
  agent.add(`Distance: ${data.distanceKm} km  |  Journey time: ~${data.durationHours} hrs  |  Road: ${data.roadType}`);
  agent.add(`Bus types available: ${data.busTypes.map(b => b.type).join(', ')}`);
  agent.add(`Would you like the timetable or fares?`);

  rememberCity(agent, destination, origin);
}

function timetableEnquiry(agent) {
  const destination = resolveDestination(agent);
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have timetable information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
  }

  agent.add(`Here's the timetable from Colombo to ${destination}:`);
  data.busTypes.forEach(bus => {
    agent.add(`${bus.type}: ${bus.departureTimes.join(', ')}`);
  });

  rememberCity(agent, destination);
}

function busTypeEnquiry(agent) {
  const destination = resolveDestination(agent);
  const busType = agent.parameters.busType;
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
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

  rememberCity(agent, destination);
}

function roadTypeEnquiry(agent) {
  const destination = resolveDestination(agent);
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have road information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
  }
  agent.add(`Buses to ${destination} travel via: ${data.roadType}.`);

  rememberCity(agent, destination);
}

function fareEnquiry(agent) {
  const destination = resolveDestination(agent);
  const busType = agent.parameters.busType;
  const data = getCityData(destination);

  if (!data) {
    agent.add(`Sorry, I don't have fare information for "${destination}".`);
    agent.add(`We cover: ${listKnownCities()}.`);
    return;
  }

  if (busType) {
    const match = data.busTypes.find(
      b => b.type.toLowerCase() === String(busType).toLowerCase()
    );
    if (match) {
      agent.add(`The fare for ${match.type} to ${destination} is Rs. ${match.fare}.`);
      rememberCity(agent, destination);
      return;
    }
  }

  agent.add(`Fares to ${destination}:`);
  data.busTypes.forEach(bus => {
    agent.add(`${bus.type}: Rs. ${bus.fare}`);
  });

  rememberCity(agent, destination);
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
  // Follow-up intents: same handlers, just triggered by context-only phrasing
  intentMap.set('timetable.followup', timetableEnquiry);
  intentMap.set('busType.followup', busTypeEnquiry);
  intentMap.set('roadType.followup', roadTypeEnquiry);
  intentMap.set('fare.followup', fareEnquiry);
  intentMap.set('Default Fallback Intent', fallback);

  agent.handleRequest(intentMap);
};
