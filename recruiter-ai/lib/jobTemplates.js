// lib/jobTemplates.js
//
// Pre-built JobSpec templates across fields, used to seed the criteria form.
//
// Exports:
//   JOB_TEMPLATES              JobSpec[]
//   templatesForField(field)   JobSpec[]
//   getTemplate(field, title)  JobSpec|undefined

export const JOB_TEMPLATES = [
  // ---- software ----
  {
    field: "software",
    title: "Frontend Engineer",
    location: null,
    criteria: [
      { key: "skills", label: "Core Skills", weight: 5, requiredSkills: ["javascript", "react", "css", "typescript"] },
      { key: "experience", label: "Years of Experience", weight: 4, minYears: 3 },
      { key: "education", label: "Education Level", weight: 2, minEducationLevel: 3 },
      { key: "keyword", label: "Frontend Focus", weight: 2, keywords: ["frontend", "accessibility", "responsive design"] },
    ],
  },
  {
    field: "software",
    title: "Backend Engineer",
    location: null,
    criteria: [
      { key: "skills", label: "Core Skills", weight: 5, requiredSkills: ["node.js", "python", "sql", "rest api"] },
      { key: "experience", label: "Years of Experience", weight: 4, minYears: 4 },
      { key: "education", label: "Education Level", weight: 2, minEducationLevel: 3 },
      { key: "keyword", label: "Backend Focus", weight: 2, keywords: ["backend", "microservices", "scalability"] },
    ],
  },
  {
    field: "software",
    title: "Data Scientist",
    location: null,
    criteria: [
      { key: "skills", label: "Core Skills", weight: 5, requiredSkills: ["python", "sql", "machine learning", "statistics"] },
      { key: "education", label: "Education Level", weight: 3, minEducationLevel: 4 },
      { key: "experience", label: "Years of Experience", weight: 3, minYears: 2 },
      { key: "keyword", label: "Domain Focus", weight: 2, keywords: ["data science", "modeling", "analytics"] },
    ],
  },

  // ---- healthcare ----
  {
    field: "healthcare",
    title: "Registered Nurse",
    location: null,
    criteria: [
      { key: "certifications", label: "Required Certifications", weight: 5, requiredCerts: ["RN", "BLS"] },
      { key: "education", label: "Education Level", weight: 3, minEducationLevel: 3 },
      { key: "experience", label: "Years of Experience", weight: 3, minYears: 2 },
      { key: "skills", label: "Core Skills", weight: 3, requiredSkills: ["patient care", "EHR"] },
    ],
  },
  {
    field: "healthcare",
    title: "Medical Lab Technician",
    location: null,
    criteria: [
      { key: "certifications", label: "Required Certifications", weight: 5, requiredCerts: ["MLT", "ASCP"] },
      { key: "education", label: "Education Level", weight: 3, minEducationLevel: 2 },
      { key: "skills", label: "Core Skills", weight: 4, requiredSkills: ["lab testing", "specimen handling", "quality control"] },
      { key: "experience", label: "Years of Experience", weight: 2, minYears: 1 },
    ],
  },

  // ---- finance ----
  {
    field: "finance",
    title: "Accountant",
    location: null,
    criteria: [
      { key: "certifications", label: "Certifications", weight: 4, requiredCerts: ["CPA"] },
      { key: "skills", label: "Core Skills", weight: 4, requiredSkills: ["bookkeeping", "excel", "reconciliation", "gaap"] },
      { key: "education", label: "Education Level", weight: 3, minEducationLevel: 3 },
      { key: "experience", label: "Years of Experience", weight: 3, minYears: 2 },
    ],
  },
  {
    field: "finance",
    title: "Financial Analyst",
    location: null,
    criteria: [
      { key: "certifications", label: "Certifications", weight: 3, requiredCerts: ["CFA"] },
      { key: "skills", label: "Core Skills", weight: 5, requiredSkills: ["financial modeling", "excel", "valuation", "forecasting"] },
      { key: "education", label: "Education Level", weight: 3, minEducationLevel: 4 },
      { key: "experience", label: "Years of Experience", weight: 3, minYears: 3 },
    ],
  },

  // ---- sales ----
  {
    field: "sales",
    title: "Sales Representative",
    location: null,
    criteria: [
      { key: "skills", label: "Core Skills", weight: 4, requiredSkills: ["negotiation", "crm", "cold calling"] },
      { key: "experience", label: "Years of Experience", weight: 3, minYears: 1 },
      { key: "keyword", label: "Sales Focus", weight: 3, keywords: ["quota", "b2b", "closing"] },
      { key: "location", label: "Location Preference", weight: 1, desiredLocation: "Remote" },
    ],
  },

  // ---- marketing ----
  {
    field: "marketing",
    title: "Marketing Manager",
    location: null,
    criteria: [
      { key: "skills", label: "Core Skills", weight: 4, requiredSkills: ["seo", "content strategy", "campaign management", "analytics"] },
      { key: "experience", label: "Years of Experience", weight: 3, minYears: 3 },
      { key: "education", label: "Education Level", weight: 2, minEducationLevel: 3 },
      { key: "keyword", label: "Marketing Focus", weight: 3, keywords: ["brand", "growth", "digital marketing"] },
    ],
  },

  // ---- design ----
  {
    field: "design",
    title: "UX Designer",
    location: null,
    criteria: [
      { key: "skills", label: "Core Skills", weight: 5, requiredSkills: ["figma", "user research", "wireframing", "prototyping"] },
      { key: "experience", label: "Years of Experience", weight: 3, minYears: 2 },
      { key: "education", label: "Education Level", weight: 2, minEducationLevel: 3 },
      { key: "keyword", label: "Design Focus", weight: 2, keywords: ["ux", "design systems", "usability"] },
    ],
  },

  // ---- operations ----
  {
    field: "operations",
    title: "Project Manager",
    location: null,
    criteria: [
      { key: "certifications", label: "Certifications", weight: 3, requiredCerts: ["PMP"] },
      { key: "skills", label: "Core Skills", weight: 4, requiredSkills: ["agile", "stakeholder management", "scheduling"] },
      { key: "experience", label: "Years of Experience", weight: 4, minYears: 4 },
      { key: "location", label: "Location Preference", weight: 1, desiredLocation: "New York" },
    ],
  },
];

export function templatesForField(field) {
  const f = String(field || "").toLowerCase().trim();
  if (!f) return [];
  return JOB_TEMPLATES.filter((t) => t.field.toLowerCase() === f);
}

export function getTemplate(field, title) {
  const f = String(field || "").toLowerCase().trim();
  const t = String(title || "").toLowerCase().trim();
  return JOB_TEMPLATES.find(
    (tpl) => tpl.field.toLowerCase() === f && tpl.title.toLowerCase() === t
  );
}
