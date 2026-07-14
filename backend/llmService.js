const https = require('https');
require('dotenv').config();

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = 'gemini-1.5-flash';

/**
 * Helper to make a secure HTTPS POST request.
 */
function postRequest(url, data) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const options = {
      method: 'POST',
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(JSON.stringify(data))
      },
      timeout: 30000 // 30 seconds timeout
    };

    const req = https.request(options, (res) => {
      // Force response encoding to utf8 to safely handle multi-byte characters (e.g. °F)
      res.setEncoding('utf8');
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(body);
        } else {
          reject(new Error(`HTTP Status Code: ${res.statusCode}. Body: ${body}`));
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(JSON.stringify(data));
    req.end();
  });
}

/**
 * Helper to repair potentially truncated JSON strings before parsing.
 */
function repairJson(str) {
  str = str.trim();
  try {
    JSON.parse(str);
    return str;
  } catch (e) {
    // Continue with repair logic
  }

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}') {
      if (stack[stack.length - 1] === '{') {
        stack.pop();
      }
    } else if (char === ']') {
      if (stack[stack.length - 1] === '[') {
        stack.pop();
      }
    }
  }

  if (inString) {
    str += '"';
  }

  // Remove trailing comma or invalid characters at truncation point
  str = str.replace(/,\s*$/, '');

  while (stack.length > 0) {
    const open = stack.pop();
    if (open === '{') {
      str += '}';
    } else if (open === '[') {
      str += ']';
    }
  }

  return str;
}

/**
 * Offline rule-based analyzer for symptom reports.
 */
function fallbackAnalyzeSymptoms(symptoms) {
  const text = symptoms.toLowerCase();
  
  // Detect symptom categories
  const matchedSymptoms = [];
  const matchedCategories = [];

  const symptomMap = [
    { category: 'chest_pain', name: 'chest pain / heart issues', keywords: ['chest pain', 'heart', 'cardiac', 'angina', 'chest tightness'] },
    { category: 'breathing', name: 'breathing difficulty', keywords: ['breathing', 'breath', 'shortness of breath', 'dyspnea', 'asthma', 'wheezing', 'wheez'] },
    { category: 'bleeding', name: 'active bleeding', keywords: ['bleeding', 'bleed', 'blood', 'hemorrhage'] },
    { category: 'stroke', name: 'neurological symptoms', keywords: ['stroke', 'numbness', 'paralysis', 'slurred speech', 'weakness on one side'] },
    { category: 'unconscious', name: 'loss of consciousness / dizziness', keywords: ['unconscious', 'passed out', 'faint', 'syncope', 'blackout', 'dizzy'] },
    { category: 'severe_pain', name: 'severe pain', keywords: ['severe pain', 'excruciating', 'unbearable pain', 'intense pain'] },
    { category: 'fever', name: 'fever', keywords: ['fever', 'high temp', 'temperature', 'chills', 'febrile'] },
    { category: 'cough', name: 'cough', keywords: ['cough', 'congestion', 'cold', 'sore throat', 'runny nose'] },
    { category: 'rash', name: 'skin allergy / rash', keywords: ['rash', 'allergy', 'hives', 'itching', 'skin', 'eczema', 'allergic'] },
    { category: 'gi', name: 'gastrointestinal issues', keywords: ['vomit', 'nausea', 'diarrhea', 'stomach', 'abdominal pain', 'cramps', 'gi'] },
    { category: 'headache', name: 'headache / migraine', keywords: ['migraine', 'headache', 'head pain'] },
    { category: 'fracture', name: 'physical injury', keywords: ['fracture', 'broken', 'sprain', 'injury', 'fall', 'hurt', 'wound'] },
    { category: 'infection', name: 'suspected infection', keywords: ['infection', 'pus', 'inflammation', 'swollen', 'swelling'] }
  ];

  for (const item of symptomMap) {
    if (item.keywords.some(kw => text.includes(kw))) {
      matchedSymptoms.push(item.name);
      matchedCategories.push(item.category);
    }
  }

  // Urgency Detection
  let urgency = 'Low';
  const highKeywords = ['chest pain', 'breathing', 'shortness of breath', 'bleeding', 'stroke', 'unconscious', 'severe pain', 'heart', 'angina', 'excruciating', 'unbearable'];
  const mediumKeywords = ['fever', 'vomit', 'migraine', 'cough', 'fracture', 'infection', 'rash', 'diarrhea', 'nausea', 'allergy', 'hives', 'itching', 'skin', 'swelling', 'swollen'];

  if (highKeywords.some(kw => text.includes(kw))) {
    urgency = 'High';
  } else if (mediumKeywords.some(kw => text.includes(kw))) {
    urgency = 'Medium';
  }

  // Symptom-specific chief complaint
  let complaint = '';
  if (matchedSymptoms.length > 0) {
    if (matchedSymptoms.length === 1) {
      complaint = `Symptom report for ${matchedSymptoms[0]}`;
    } else {
      complaint = `Symptom report for ${matchedSymptoms.slice(0, -1).join(', ')} and ${matchedSymptoms[matchedSymptoms.length - 1]}`;
    }
  } else {
    let cleanSymptoms = symptoms.trim();
    if (cleanSymptoms.length > 0) {
      complaint = cleanSymptoms.substring(0, 60) + (cleanSymptoms.length > 60 ? '...' : '');
    } else {
      complaint = 'General check-up request';
    }
  }

  // Symptom-specific suggested questions pools
  const questionPools = {
    chest_pain: [
      'Does the pain radiate to your left arm, neck, jaw, or back?',
      'Are you experiencing sweating, nausea, or shortness of breath with the pain?',
      'Do you have a history of heart disease, high blood pressure, or high cholesterol?'
    ],
    breathing: [
      'When did the breathing difficulty start, and does it worsen when lying down?',
      'Are you experiencing any wheezing, coughing, or chest tightness?',
      'Do you have a history of asthma, COPD, or severe allergic reactions?'
    ],
    bleeding: [
      'Where is the bleeding coming from, and how long has it been occurring?',
      'Are you able to apply pressure to control or slow down the bleeding?',
      'Are you taking any blood thinners or do you have a bleeding disorder?'
    ],
    stroke: [
      'Are you experiencing any sudden numbness, weakness, or slurred speech?',
      'When was the exact time you or someone else noticed these symptoms start?',
      'Do you have a history of high blood pressure, stroke, or transient ischemic attacks (TIAs)?'
    ],
    unconscious: [
      'Did the loss of consciousness happen suddenly, and for how long were you unresponsive?',
      'Were there any warning signs beforehand like dizziness, sweating, or vision changes?',
      'Have you had similar episodes in the past, or do you have a history of diabetes or heart conditions?'
    ],
    severe_pain: [
      'Can you describe the location and nature of the pain (e.g., sharp, throbbing, constant)?',
      'What makes the pain better or worse, and have you taken any pain relievers?',
      'Is the pain accompanied by other symptoms like fever, nausea, or numbness?'
    ],
    fever: [
      'What is your current body temperature, and has it been increasing?',
      'Are you experiencing chills, sweating, muscle aches, or a headache?',
      'Have you recently traveled or been exposed to anyone who is sick?'
    ],
    cough: [
      'Is the cough dry, or are you coughing up phlegm/mucus?',
      'Have you had a recent cold, runny nose, sore throat, or congestion?',
      'Does the cough worsen at night or during physical exertion?'
    ],
    rash: [
      'Is the rash itchy, painful, warm to the touch, or spreading?',
      'Have you been exposed to new foods, soaps, cosmetics, plants, or medications?',
      'Are there any visible signs of swelling or spreading rash?'
    ],
    gi: [
      'Are you able to keep fluids down, or are you experiencing signs of dehydration?',
      'How long have you been experiencing nausea, vomiting, or diarrhea?',
      'Have you recently eaten anything that could be contaminated or undercooked?'
    ],
    headache: [
      'Is the headache concentrated on one side of your head, throbbing, or constant?',
      'Are you experiencing sensitivity to light, sound, or nausea with the headache?',
      'Did the headache start suddenly, and how severe is it on a scale of 1-10?'
    ],
    fracture: [
      'Are you able to bear weight or move the affected limb/joint?',
      'Is there visible swelling, bruising, or deformity in the injured area?',
      'How and when did the injury occur?'
    ],
    infection: [
      'Are there signs of localized infection like redness, warmth, pus, or swelling?',
      'Are you experiencing a fever or chills alongside the localized symptoms?',
      'How long have you noticed the symptoms, and are they spreading?'
    ],
    general: [
      'How long have you been experiencing these symptoms?',
      'Have you taken any over-the-counter medications to treat this?',
      'Does the discomfort worsen during specific times of the day?'
    ]
  };

  let questions = [];
  if (matchedCategories.length > 0) {
    if (matchedCategories.length === 1) {
      questions = [...questionPools[matchedCategories[0]]];
    } else if (matchedCategories.length === 2) {
      questions = [
        questionPools[matchedCategories[0]][0],
        questionPools[matchedCategories[0]][1],
        questionPools[matchedCategories[1]][0]
      ];
    } else {
      questions = [
        questionPools[matchedCategories[0]][0],
        questionPools[matchedCategories[1]][0],
        questionPools[matchedCategories[2]][0]
      ];
    }
  } else {
    if (urgency === 'High') {
      questions = [...questionPools.chest_pain];
    } else if (urgency === 'Medium') {
      questions = [...questionPools.fever];
    } else {
      questions = [...questionPools.general];
    }
  }

  // Ensure exactly 3 questions
  while (questions.length < 3) {
    questions.push(questionPools.general[questions.length] || 'Are you experiencing any other symptoms?');
  }
  questions = questions.slice(0, 3);

  return {
    urgency_level: urgency,
    chief_complaint: complaint,
    suggested_questions: questions
  };
}

/**
 * Offline rule-based parser for post-visit clinical notes.
 */
function fallbackAnalyzeNotes(notes) {
  // Helper to parse duration in days
  function parseDuration(text) {
    const rangeWeeksMatch = text.match(/for\s+(\d+)\s*(?:-|–|to)\s*(\d+)\s*weeks?/i);
    if (rangeWeeksMatch) {
      return parseInt(rangeWeeksMatch[2], 10) * 7;
    }
    const rangeDaysMatch = text.match(/for\s+(\d+)\s*(?:-|–|to)\s*(\d+)\s*days?/i);
    if (rangeDaysMatch) {
      return parseInt(rangeDaysMatch[2], 10);
    }
    const weeksMatch = text.match(/for\s+(\d+)\s*weeks?/i);
    if (weeksMatch) {
      return parseInt(weeksMatch[1], 10) * 7;
    }
    const daysMatch = text.match(/for\s+(\d+)\s*days?/i);
    if (daysMatch) {
      return parseInt(daysMatch[1], 10);
    }
    return 7;
  }

  // Helper to check if a line represents instructions rather than medication header
  function isInstructionLine(line) {
    const clean = line.replace(/^(?:\d+[\s\.)\]-]*|[-*•])\s*/, '').trim().toLowerCase();
    if (/^(?:take|apply|use|give|patient\s+should|drink|consume|rub|drop|spray|inhale)/.test(clean)) {
      return true;
    }
    return false;
  }

  // Helper to filter for actual medications and exclude generic procedures, tests, or advice
  function isActualMedication(line) {
    const clean = line.toLowerCase();
    const exclusions = [
      'ecg', 'ekg', 'oxygen', 'therapy', 'monitor', 'blood pressure', 'bp', 'refer', 'rest', 
      'diet', 'avoid', 'exercise', 'evaluate', 'evaluation', 'assess', 'assessment', 
      'consult', 'visit', 'appointment', 'hydration', 'fluid', 'water', 'checkup', 
      'department', 'cardiologist', 'emergency', 'lifestyle', 'advice', 'test', 'scan', 
      'x-ray', 'mri', 'ultrasound', 'blood work', 'lab', 'hospital', 'bed rest'
    ];
    if (exclusions.some(exc => clean.includes(exc))) {
      return false;
    }
    const drugUnits = /\b\d+(?:\.\d+)?\s*(mg|ml|g|mcg|%|units|tabs?|tablets?|caps?|capsules?|pills?|puffs?|drops?)\b/i;
    const commonDrugNames = /\b(aspirin|paracetamol|acetaminophen|ibuprofen|amoxicillin|metformin|atorvastatin|lisinopril|amlodipine|albuterol|levothyroxine|metoprolol|losartan|gabapentin|omeprazole|simvastatin|penicillin|clopidogrel|pantoprazole|prednisone)\b/i;
    const dosageKeywords = /\b(take|apply|use|consume|twice|daily|weekly|inhale)\b/i;
    
    return drugUnits.test(clean) || commonDrugNames.test(clean) || dosageKeywords.test(clean);
  }

  // Helper to simplify jargon into layman terms
  function simplifyJargon(text) {
    let clean = text;
    const jargonMap = [
      { regex: /\bdyspnea\b/gi, replacement: 'shortness of breath' },
      { regex: /\bangina\b/gi, replacement: 'chest pain/discomfort' },
      { regex: /\bhemodynamically stable\b/gi, replacement: 'vitals are stable' },
      { regex: /\bhypertension\b/gi, replacement: 'high blood pressure' },
      { regex: /\bexertion\b/gi, replacement: 'physical activity' },
      { regex: /\bmyocardial infarction\b/gi, replacement: 'heart attack' },
      { regex: /\bcephalalgia\b/gi, replacement: 'headache' },
      { regex: /\bpruritus\b/gi, replacement: 'itching' },
      { regex: /\berythema\b/gi, replacement: 'redness' },
      { regex: /\bedema\b/gi, replacement: 'swelling' },
      { regex: /\bbradycardia\b/gi, replacement: 'slow heart rate' },
      { regex: /\btachycardia\b/gi, replacement: 'fast heart rate' },
      { regex: /\bhematuria\b/gi, replacement: 'blood in urine' },
      { regex: /\bcardiac evaluation\b/gi, replacement: 'heart health check' },
      { regex: /\bstrenuous\b/gi, replacement: 'heavy' },
      { regex: /\bevaluated\b/gi, replacement: 'checked' },
      { regex: /\bacute gastroenteritis\b/gi, replacement: 'stomach flu (stomach infection)' },
      { regex: /\boral hydration\b/gi, replacement: 'drinking fluids' },
      { regex: /\bdehydration\b/gi, replacement: 'loss of fluids' },
      { regex: /\bloose stools\b/gi, replacement: 'diarrhea' },
      { regex: /\bgeneralized weakness\b/gi, replacement: 'feeling weak overall' },
      { regex: /\breduced appetite\b/gi, replacement: 'not feeling like eating' },
      { regex: /\babdominal\b/gi, replacement: 'stomach' }
    ];
    for (const mapping of jargonMap) {
      clean = clean.replace(mapping.regex, mapping.replacement);
    }
    return clean;
  }

  // Helper to identify markdown table syntax (headers and separators)
  function isMarkdownTableHeaderOrDivider(line) {
    const clean = line.trim();
    if (!clean.startsWith('|')) return false;
    
    // Check if it's a divider line: contains only pipes, hyphens, colons, spaces
    if (/^[|:\-\s]+$/.test(clean)) {
      return true;
    }
    
    // Check if it contains table header keywords
    const lower = clean.toLowerCase();
    if (lower.includes('medicine') || lower.includes('dosage') || lower.includes('duration') || lower.includes('instructions') || lower.includes('frequency')) {
      return true;
    }
    
    return false;
  }

  const parts = notes.split(/Prescription:\s*/i);
  const notesPart = parts[0] || '';
  const prescriptionPart = parts[1] || '';

  const notesLines = notesPart.split('\n').map(l => l.trim()).filter(Boolean);
  const prescriptionLines = prescriptionPart.split('\n').map(l => l.trim()).filter(Boolean);

  const medications = [];
  const meds = [];
  let currentMed = null;

  const extraAdvice = [];
  const extraFollowups = [];

  for (const line of prescriptionLines) {
    const cleanLine = line.replace(/^(?:\d+[\s\.)\]-]*|[-*•])\s*/, '').trim();
    if (!cleanLine) continue;

    if (isMarkdownTableHeaderOrDivider(cleanLine)) {
      continue;
    }

    // Handle markdown table row parsing
    if (cleanLine.startsWith('|') && cleanLine.endsWith('|')) {
      const cols = cleanLine.split('|').map(c => c.trim()).filter((c, i, arr) => i > 0 && i < arr.length - 1);
      if (cols.length >= 2) {
        let cleanName = cols[0].replace(/\*\*/g, '').trim();
        let cleanDosage = cols[1].replace(/\*\*/g, '').trim();
        let cleanInstruction = cols[3] ? cols[3].replace(/\*\*/g, '').trim() : (cols[2] ? cols[2].replace(/\*\*/g, '').trim() : '');
        
        // Strip colon and clean up strength from name
        if (cleanName.includes(':')) {
          cleanName = cleanName.split(':')[0].trim();
        }
        cleanName = cleanName.replace(/\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg|%|units|tabs?|tablets?|caps?|capsules?|pills?|puffs?|drops?)/gi, '').trim();
        cleanName = cleanName.replace(/[-–,]/g, ' ').replace(/\s+/g, ' ').trim();

        if (isActualMedication(cols[0])) { // Check original column to verify it's a drug
          const durationDays = parseDuration(cleanLine);
          const startDate = new Date().toISOString().split('T')[0];
          const endDateObj = new Date();
          endDateObj.setDate(endDateObj.getDate() + durationDays);
          const endDate = endDateObj.toISOString().split('T')[0];
          
          let frequency = 'daily';
          const cleanInstructionLower = cleanInstruction.toLowerCase();
          if (
            cleanInstructionLower.includes('twice') || 
            cleanInstructionLower.includes('2 times') || 
            cleanInstructionLower.includes('12 hours') || 
            cleanInstructionLower.includes('bid') || 
            cleanInstructionLower.includes('b.i.d.') || 
            cleanInstructionLower.includes('bd')
          ) {
            frequency = 'twice_daily';
          } else if (
            cleanInstructionLower.includes('weekly') || 
            cleanInstructionLower.includes('once a week') || 
            cleanInstructionLower.includes('every week') || 
            cleanInstructionLower.includes('once weekly')
          ) {
            frequency = 'weekly';
          }

          medications.push({
            name: cleanName,
            dosage: cleanDosage || 'As directed',
            frequency: frequency,
            start_date: startDate,
            end_date: endDate
          });
          continue;
        }
      }
    }

    // Strict filter
    if (!isActualMedication(cleanLine) && !isInstructionLine(cleanLine)) {
      if (/refer|cardiologist|emergency|consult|visit|appointment|ecg|ekg|test|scan|lab/i.test(cleanLine)) {
        extraFollowups.push(cleanLine);
      } else {
        extraAdvice.push(cleanLine);
      }
      continue;
    }

    if (isInstructionLine(cleanLine)) {
      if (currentMed) {
        currentMed.instructions.push(cleanLine);
      } else {
        currentMed = {
          header: 'Prescribed Medication',
          instructions: [cleanLine]
        };
        meds.push(currentMed);
      }
    } else {
      currentMed = {
        header: cleanLine,
        instructions: []
      };
      meds.push(currentMed);
    }
  }

  // medications array already declared at function start
  for (const med of meds) {
    if (!med.header || (med.header === 'Prescribed Medication' && med.instructions.length === 0)) {
      continue;
    }

    let name = med.header;
    let dosage = 'As directed';

    if (name.includes(':')) {
      const colParts = name.split(':');
      name = colParts[0].trim();
      
      const rest = colParts.slice(1).join(':').trim();
      const strengthMatch = rest.match(/(\d+(?:\.\d+)?\s*(?:mg|ml|%|g|mcg|units\b))/i);
      if (strengthMatch) {
        dosage = strengthMatch[1].trim();
      }
    } else {
      const headerRegex = /^([a-zA-Z0-9\s%\-\.\/()]+?)\s+(\d+(?:\.\d+)?\s*(?:mg|ml|%|g|mcg|units\b))\s*([a-zA-Z]+)?/i;
      const headerMatch = name.match(headerRegex);
      if (headerMatch) {
        const drugName = headerMatch[1].trim();
        const strength = headerMatch[2].trim();
        const form = headerMatch[3] ? headerMatch[3].trim() : '';

        const isTopical = /cream|lotion|gel|ointment|drops|spray|inhaler/i.test(form || drugName);
        if (isTopical) {
          name = drugName + ' ' + strength + (form ? ' ' + form : '');
          dosage = 'Apply as directed';
        } else {
          name = drugName;
          dosage = strength;
        }
      }
    }

    // Generic fallback cleanup for name
    name = name.replace(/\d+(?:\.\d+)?\s*(?:mg|ml|g|mcg|%|units|tabs?|tablets?|caps?|capsules?|pills?|puffs?|drops?)/gi, '');
    name = name.replace(/for\s+\d+\s*(?:-|–|to)?\s*\d*\s*(?:days?|weeks?)/gi, '');
    name = name.replace(/taken\s+(?:daily|weekly|twice\s+daily)/gi, '');
    name = name.replace(/[-–,]/g, ' ').replace(/\s+/g, ' ').trim();
    name = name.replace(/\(optional\)/i, '').trim();

    const instructionText = med.instructions.join(' ');
    const durationDays = parseDuration(instructionText || med.header);

    let cleanInstructionText = (instructionText || med.header)
      .replace(/for\s+\d+\s*(?:-|–|to)?\s*\d*\s*(?:days?|weeks?)/gi, '')
      .toLowerCase();

    let frequency = 'daily';
    if (
      cleanInstructionText.includes('twice') || 
      cleanInstructionText.includes('2 times') || 
      cleanInstructionText.includes('12 hours') || 
      cleanInstructionText.includes('bid') || 
      cleanInstructionText.includes('b.i.d.') || 
      cleanInstructionText.includes('bd')
    ) {
      frequency = 'twice_daily';
    } else if (
      cleanInstructionText.includes('weekly') || 
      cleanInstructionText.includes('once a week') || 
      cleanInstructionText.includes('every week') || 
      cleanInstructionText.includes('once weekly')
    ) {
      frequency = 'weekly';
    }

    const dosageRegex = /(\d+(?:\s*tab(?:let)?s?|\s*caps(?:ule)?s?|\s*pills?|\s*puffs?|\s*drops?)|apply\s+a\s+thin\s+layer)/i;
    const dosageMatch = instructionText.match(dosageRegex);
    if (dosageMatch) {
      dosage = dosageMatch[1].trim();
    }

    const startDate = new Date().toISOString().split('T')[0];
    const endDateObj = new Date();
    endDateObj.setDate(endDateObj.getDate() + durationDays);
    const endDate = endDateObj.toISOString().split('T')[0];

    medications.push({
      name,
      dosage,
      frequency,
      start_date: startDate,
      end_date: endDate
    });
  }

  // If no medications found, check common names in the text
  if (medications.length === 0) {
    const commonMeds = ['Amoxicillin', 'Ibuprofen', 'Paracetamol', 'Aspirin', 'Metformin', 'Atorvastatin', 'Albuterol', 'Lisinopril'];
    for (const med of commonMeds) {
      if (new RegExp(med, 'i').test(notes)) {
        const startDate = new Date().toISOString().split('T')[0];
        const endDateObj = new Date();
        endDateObj.setDate(endDateObj.getDate() + 7);
        const endDate = endDateObj.toISOString().split('T')[0];

        medications.push({
          name: med,
          dosage: 'As directed',
          frequency: 'daily',
          start_date: startDate,
          end_date: endDate
        });
      }
    }
  }

  // Group lines from Notes Part to build diagnosis, lifestyle, and followups
  let diagnosisList = [];
  let lifestyleList = [];
  let followupList = [];

  const dxRegex = /(?:diagnose|diagnosis|diagnosed|dx|suffering|presenting|infection|bronchitis|flu|cold|hypertension|diabetes|asthma|allergy|illness)/i;
  const lifestyleRegex = /(?:rest|fluid|hydrate|water|diet|avoid|limit|drink|smoke|exercise|activity|sleep|stress|apply|warm|cold|healthy|wash|clean)/i;
  const followupRegex = /(?:follow\s*up|followup|f\/u|return|recheck|consult|see\s*you|next\s*visit|appointment|weeks|days|week|day)/i;
  const medIndicatorRegex = /(?:prescribe|rx|take|give|pill|tablet|capsule|mg|ml|dose|medication)/i;

  for (const line of notesLines) {
    if (isMarkdownTableHeaderOrDivider(line)) continue;
    if (medIndicatorRegex.test(line)) continue;

    if (dxRegex.test(line)) {
      diagnosisList.push(line);
    } else if (lifestyleRegex.test(line)) {
      lifestyleList.push(line);
    } else if (followupRegex.test(line)) {
      followupList.push(line);
    } else {
      diagnosisList.push(line); // Default to diagnosis/assessment
    }
  }

  // Add the extra categories from prescription parsing
  lifestyleList = lifestyleList.concat(extraAdvice);
  followupList = followupList.concat(extraFollowups);

  // Fallbacks if lists are empty
  if (diagnosisList.length === 0) {
    diagnosisList.push("Routine assessment / clinic check-up");
  }

  if (followupList.length === 0) {
    followupList.push("Contact the clinic if symptoms worsen or fail to improve.");
  }

  // Simplify all jargon
  const cleanDiagnosisList = diagnosisList.map(simplifyJargon);
  const cleanLifestyleList = lifestyleList.map(simplifyJargon);
  const cleanFollowupList = followupList.map(simplifyJargon);

  // Build a warm, conversational patient summary
  const diagnosisPart = cleanDiagnosisList.join(' ');

  let medicationPart = '';
  if (medications.length > 0) {
    const medLines = medications.map(med => {
      const freqLabel =
        med.frequency === 'twice_daily' ? 'twice a day'
        : med.frequency === 'weekly' ? 'once a week'
        : 'once a day';
      return `${med.name} (${med.dosage}) — take this ${freqLabel} from ${med.start_date} to ${med.end_date}`;
    });
    if (medLines.length === 1) {
      medicationPart = `We have prescribed you ${medLines[0]}.`;
    } else {
      const last = medLines.pop();
      medicationPart = `We have prescribed a few medications to help with your recovery. Please take ${medLines.join(', ')}, and also ${last}. Make sure to complete the full course even if you start feeling better earlier.`;
    }
  }

  const lifestylePart = cleanLifestyleList.length > 0
    ? `A few things that will really help your recovery: ${cleanLifestyleList.join('. ')}.`
    : '';

  const followupPart = cleanFollowupList.length > 0
    ? cleanFollowupList.join(' ')
    : 'Please reach out to the clinic if you feel your symptoms are getting worse or not improving.';

  let patientSummary = `We\'re glad you came in today, and we hope your visit was helpful.\n\n`;
  patientSummary += `Here is a quick summary of what we discussed and what to do next:\n\n`;

  if (diagnosisPart) {
    patientSummary += `🩺 What We Found\n${diagnosisPart}\n\n`;
  }

  if (medicationPart) {
    patientSummary += `💊 Your Medications\n${medicationPart}\n\n`;
  }

  if (lifestylePart) {
    patientSummary += `🌿 Taking Care of Yourself\n${lifestylePart}\n\n`;
  }

  patientSummary += `📅 When to Follow Up\n${followupPart}\n\n`;
  patientSummary += `Take good care, and don't hesitate to reach out if you need anything. Wishing you a smooth and speedy recovery! 💙`;

  return {
    patient_summary: patientSummary,
    medications
  };
}

/**
 * Pre-visit symptoms analyzer using Gemini
 */
async function analyzeSymptoms(symptoms) {
  if (!API_KEY) {
    console.log('[LLM Service] No API Key provided, using offline symptom analyzer.');
    return fallbackAnalyzeSymptoms(symptoms);
  }

  const prompt = `You are a clinical assistant. Analyze the patient's symptoms: "${symptoms}".
Return a JSON object containing:
1. "urgency_level": Must be exactly "Low", "Medium", or "High" based on symptom severity.
2. "chief_complaint": A concise 1-sentence summary (max 15 words) of the main issue. It MUST be symptom-specific and patient-specific (e.g. "Patient reports persistent chest pain radiating to left arm"), not a generic category name.
3. "suggested_questions": An array of exactly 3 relevant diagnostic questions tailored specifically to these symptoms that the doctor should ask the patient.

Format the output strictly as plain JSON matching this schema:
{
  "urgency_level": "Low" | "Medium" | "High",
  "chief_complaint": "string",
  "suggested_questions": ["string", "string", "string"]
}
Do not wrap in markdown backticks, return plain JSON.`;

  const schema = {
    type: "OBJECT",
    properties: {
      urgency_level: {
        type: "STRING",
        enum: ["Low", "Medium", "High"]
      },
      chief_complaint: {
        type: "STRING"
      },
      suggested_questions: {
        type: "ARRAY",
        items: {
          type: "STRING"
        }
      }
    },
    required: ["urgency_level", "chief_complaint", "suggested_questions"]
  };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    };

    const responseText = await postRequest(url, payload);
    if (!responseText) {
      throw new Error('Empty response from Gemini API');
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (e) {
      throw new Error('Malformed JSON returned from Gemini API: ' + e.message);
    }

    if (!responseJson || !responseJson.candidates || !responseJson.candidates[0] || !responseJson.candidates[0].content || !responseJson.candidates[0].content.parts || !responseJson.candidates[0].content.parts[0]) {
      throw new Error('Malformed response structure from Gemini API');
    }

    const outputText = responseJson.candidates[0].content.parts[0].text;
    if (!outputText || !outputText.trim()) {
      throw new Error('Empty text content in Gemini response');
    }

    let result;
    try {
      const repairedText = repairJson(outputText);
      result = JSON.parse(repairedText);
    } catch (e) {
      throw new Error('Failed to parse candidate JSON content: ' + e.message);
    }

    // Validate keys
    if (result.urgency_level && result.chief_complaint && Array.isArray(result.suggested_questions)) {
      // Normalize urgency
      if (!['Low', 'Medium', 'High'].includes(result.urgency_level)) {
        result.urgency_level = 'Medium';
      }
      return result;
    }
    throw new Error('LLM response did not contain expected keys');
  } catch (error) {
    console.error('[LLM Service Error] Symptom analysis failed, falling back to rule-engine:', error.message);
    return fallbackAnalyzeSymptoms(symptoms);
  }
}

/**
 * Post-visit notes analyzer using Gemini
 */
async function analyzePostVisitNotes(notes) {
  const fallbackMsg = "AI Consultation Summary Unavailable\n\n" +
    "The AI consultation summary could not be generated at this time due to a temporary AI service issue.\n\n" +
    "The patient's consultation details have been saved successfully.\n\n" +
    "No data has been lost.\n\n" +
    "Please try generating the summary again later.";

  if (!API_KEY) {
    console.log('[LLM Service] No API Key provided, using offline clinical notes parser.');
    return fallbackAnalyzeNotes(notes);
  }

  const prompt = `You are a warm, caring clinical assistant helping patients understand their visit. Convert the clinical notes and prescription below into a genuinely human, empathetic post-visit letter written directly to the patient — as if their doctor is personally talking to them.
"${notes}"

Return a JSON object containing:
1. "patient_summary": A warm, conversational message written in first-person reassuring language — NOT a clinical report. Write it as if a kind doctor is speaking directly to the patient. Use natural, flowing sentences (avoid bullet-point lists inside the text). Structure it as follows:
   - Open with a warm greeting and brief reassurance (e.g. "We're glad you came in today...")
   - Explain what was found in simple, everyday words (no medical jargon — translate everything)
   - Explain each medication warmly and clearly: what it is for, how to take it, and for how long
   - Give lifestyle advice in an encouraging, supportive tone
   - Close with warm follow-up guidance and words of encouragement
   - Translate ALL medical terms: "dyspnea" → "difficulty breathing", "angina" → "chest pain", "hypertension" → "high blood pressure", "edema" → "swelling", etc.
2. "medications": An array of prescription objects. Each object MUST contain:
   - "name": Medication name.
   - "dosage": (e.g., 500mg, 10ml, 1 tablet).
   - "frequency": Must be exactly "daily", "twice_daily", or "weekly".
   - "start_date": formatted YYYY-MM-DD (default to today if unspecified).
   - "end_date": formatted YYYY-MM-DD (calculated based on the duration, defaulting to 7 days from today if unspecified).

Format the output strictly as plain JSON matching this schema:
{
  "patient_summary": "string",
  "medications": [
    {
      "name": "string",
      "dosage": "string",
      "frequency": "daily" | "twice_daily" | "weekly",
      "start_date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD"
    }
  ]
}
Do not wrap in markdown backticks, return plain JSON.`;

  const schema = {
    type: "OBJECT",
    properties: {
      patient_summary: {
        type: "STRING"
      },
      medications: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          properties: {
            name: { type: "STRING" },
            dosage: { type: "STRING" },
            frequency: {
              type: "STRING",
              enum: ["daily", "twice_daily", "weekly"]
            },
            start_date: { type: "STRING" },
            end_date: { type: "STRING" }
          },
          required: ["name", "dosage", "frequency", "start_date", "end_date"]
        }
      }
    },
    required: ["patient_summary", "medications"]
  };

  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent?key=${API_KEY}`;
    const payload = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: schema
      }
    };

    const responseText = await postRequest(url, payload);
    if (!responseText) {
      throw new Error('Empty response from Gemini API');
    }

    let responseJson;
    try {
      responseJson = JSON.parse(responseText);
    } catch (e) {
      throw new Error('Malformed JSON returned from Gemini API: ' + e.message);
    }

    if (!responseJson || !responseJson.candidates || !responseJson.candidates[0] || !responseJson.candidates[0].content || !responseJson.candidates[0].content.parts || !responseJson.candidates[0].content.parts[0]) {
      throw new Error('Malformed response structure from Gemini API');
    }

    const outputText = responseJson.candidates[0].content.parts[0].text;
    if (!outputText || !outputText.trim()) {
      throw new Error('Empty text content in Gemini response');
    }

    let result;
    try {
      const repairedText = repairJson(outputText);
      result = JSON.parse(repairedText);
    } catch (e) {
      throw new Error('Failed to parse candidate JSON content: ' + e.message);
    }

    if (result && result.patient_summary && Array.isArray(result.medications)) {
      return result;
    }
    throw new Error('LLM response did not contain expected keys');
  } catch (error) {
    console.error('[LLM Service Error] Post-visit analysis failed, falling back to rule-engine:', error.message);
    return fallbackAnalyzeNotes(notes);
  }
}

module.exports = {
  analyzeSymptoms,
  analyzePostVisitNotes
};
