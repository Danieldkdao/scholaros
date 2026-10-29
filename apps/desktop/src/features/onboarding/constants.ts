export const academicDisclosure =
  'To help find and understand your course materials, ScholarOS shares relevant content from your connected resources with third-party inference providers.';

export type AcademicResource = {
  id: string;
  name: string;
  service: string;
  url: string;
};

export const academicResources = [
  {
    id: 'mit',
    name: 'Massachusetts Institute of Technology',
    service: 'Canvas',
    url: 'https://canvas.mit.edu',
  },
  {
    id: 'berkeley',
    name: 'University of California, Berkeley',
    service: 'bCourses',
    url: 'https://bcourses.berkeley.edu',
  },
  {
    id: 'stanford',
    name: 'Stanford University',
    service: 'Canvas',
    url: 'https://canvas.stanford.edu',
  },
  {
    id: 'harvard',
    name: 'Harvard University',
    service: 'Canvas',
    url: 'https://canvas.harvard.edu',
  },
  {
    id: 'classroom',
    name: 'Google Classroom',
    service: 'Classroom',
    url: 'https://classroom.google.com',
  },
  {
    id: 'pearson',
    name: 'Pearson',
    service: 'Textbooks',
    url: 'https://www.pearson.com',
  },
  {
    id: 'moodle',
    name: 'Moodle',
    service: 'Find your school',
    url: 'https://moodle.com/login/',
  },
  {
    id: 'canvas',
    name: 'Canvas',
    service: 'Find your school',
    url: 'https://www.instructure.com/canvas/login/free-for-teacher',
  },
] as const satisfies readonly AcademicResource[];
