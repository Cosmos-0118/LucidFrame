from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, Optional


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    message: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    result_path: Optional[str] = None

    def to_dict(self):
        return {
            "id": self.id,
            "kind": self.kind,
            "status": self.status,
            "message": self.message,
            "created_at": self.created_at.isoformat() + "Z",
            "updated_at": self.updated_at.isoformat() + "Z",
            "result_path": self.result_path,
        }


class JobStore:

    def __init__(self):
        self._jobs: Dict[str, Job] = {}

    def create(self, kind: str, message: str = "queued") -> Job:
        job_id = str(uuid.uuid4())
        job = Job(id=job_id, kind=kind, status="queued", message=message)
        self._jobs[job_id] = job
        return job

    def update(self,
               job_id: str,
               status: str,
               message: str = "",
               result_path: Optional[str] = None) -> Job:
        job = self._jobs[job_id]
        job.status = status
        job.message = message
        job.updated_at = datetime.utcnow()
        if result_path:
            job.result_path = result_path
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)


jobs = JobStore()
