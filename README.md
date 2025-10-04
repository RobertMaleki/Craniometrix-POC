# Craniometrix GUIDE Activation Agent

**AI-powered outreach assistant to activate patients and caregivers for Medicare’s GUIDE dementia care program**

---

## 🎯 Overview

The **Craniometrix GUIDE Activation Agent** is a voice AI prototype that automates patient and caregiver outreach for Medicare’s new **GUIDE (Guiding an Improved Dementia Experience)** model. It helps practices explain program benefits, verify eligibility, and initiate enrollment through conversational, empathetic outbound calls.

Built on the same architecture as our Crunch Fitness AI outbound agent, this version has been retuned for healthcare use — focusing on **compliance, empathy, and activation efficiency**.

---

## 🩺 Purpose

* Support providers participating in the CMS GUIDE model by handling the *first-touch outreach* to eligible patients and caregivers.
* Automate repetitive steps (education, eligibility screening, consent scheduling) so care navigators can focus on higher-touch work.
* Drive measurable enrollment lift while maintaining GUIDE’s human-touch and compliance requirements.

---

## ⚙️ Architecture

* **Backend:** Node.js + Express
* **Voice:** Twilio Voice API
* **Realtime AI:** OpenAI Realtime API (GPT-4o)
* **(Optional)** Visual avatar: D-ID Streaming Avatar API
* **Hosting:** Render or GitHub Codespaces

---

## 🧠 System Prompt (Example)

```text
You are “Alice,” an outreach assistant with Craniometrix, helping families learn about Medicare’s GUIDE dementia care program.
Your goal is to politely inform, answer basic questions, and offer to schedule a follow-up with a human care navigator.
Be empathetic, clear, and compliant — avoid medical advice or financial claims.
If the person expresses interest, confirm best contact info for a follow-up.
If not interested, thank them and end the call.
```

---

## ☎️ Example Call Flow

**Intro:**

> Hi, this is Alice calling from Dr. Patel’s office in partnership with Craniometrix. We’re reaching out about a new Medicare program called GUIDE, designed to help people living with memory loss and their families. Is this a good time to share a quick overview?

**If interested:**

> Wonderful! GUIDE provides personalized care coordination, 24/7 support, and even respite services for caregivers — all covered by Medicare. May I confirm if you or someone you care for has been diagnosed with dementia or Alzheimer’s?

**If eligible:**

> Great, thank you. I can connect you with our care navigator to start the enrollment process. What’s the best phone number and time to reach you?

**If not eligible / declines:**

> Understood, thank you for your time today. Have a wonderful day.

---

## 📋 Data Schema

Each call record is logged in `/data/guide_calls.json` with fields:

```json
{
  "patient_name": "",
  "caregiver_name": "",
  "interest_status": "interested | declined | callback",
  "eligibility_flag": "yes | no | uncertain",
  "consent_status": "pending | captured",
  "timestamp": ""
}
```

---

## 💬 SMS Follow-up (Twilio)

When interest is confirmed, the agent triggers an SMS:

> “Thank you for your interest in Medicare’s GUIDE program. A Craniometrix care navigator will follow up to complete your enrollment. Learn more: [link]”

---


## 🔒 Compliance Notes

* Voice AI assists but **does not replace required human navigator contact** under GUIDE.
* All calls logged for audit; no PHI stored.
* Patients can request callback by licensed human navigator.
* Fully configurable for privacy-safe operation.

---

## 🧩 Future Extensions

* Integration with GUIDE eligibility API (FHIR-based EHR sync)
* Dashboard for enrollment tracking and revenue forecasting
* Multi-language support for caregiver outreach


---

## 📬 Contact

Built by **Robert Maleki**
Contact: Robert.R.Maleki@gmail.com
