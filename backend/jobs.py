from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Dict, Optional

from .config import config


@dataclass
class Job:
    id: str
    kind: str
    status: str = "queued"
    message: str = ""
    created_at: datetime = field(default_factory=datetime.utcnow)
    updated_at: datetime = field(default_factory=datetime.utcnow)
    result_path: Optional[str] = None
    keep_until: Optional[datetime] = None

    def to_dict(self):
        return {
            "id":
            self.id,
            "kind":
            self.kind,
            "status":
            self.status,
            "message":
            self.message,
            "created_at":
            self.created_at.isoformat() + "Z",
            "updated_at":
            self.updated_at.isoformat() + "Z",
            "result_path":
            self.result_path,
            "expires_at":
            self.keep_until.isoformat() + "Z" if self.keep_until else None,
        }


class JobStore:

    def __init__(self, default_ttl_minutes: int = 30, max_jobs: int = 200):
        self._jobs: Dict[str, Job] = {}
        self.default_ttl = timedelta(minutes=default_ttl_minutes)
        self.max_jobs = max_jobs

    def create(self, kind: str, message: str = "queued") -> Job:
        # Best-effort prune before allocating a new slot
        self.prune_expired()
        if len(self._jobs) >= self.max_jobs:
            raise RuntimeError("job limit reached; try again later")
        job_id = str(uuid.uuid4())
        job = Job(id=job_id,
                  kind=kind,
                  status="queued",
                  message=message,
                  keep_until=datetime.utcnow() + self.default_ttl)
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
        # Extend TTL a bit after completion/failure
        if status in {"completed", "failed"}:
            job.keep_until = datetime.utcnow() + self.default_ttl
        return job

    def get(self, job_id: str) -> Optional[Job]:
        return self._jobs.get(job_id)

    def running_count(self) -> int:
        return sum(1 for job in self._jobs.values() if job.status == "running")

    def list_recent(self, limit: int = 20):
        recent = sorted(self._jobs.values(),
                        key=lambda j: j.updated_at,
                        reverse=True)
        return [job.to_dict() for job in recent[:limit]]

    def summary(self):
        counts: Dict[str, int] = {}
        for job in self._jobs.values():
            counts[job.status] = counts.get(job.status, 0) + 1
        return {
            "total": len(self._jobs),
            "counts": counts,
            "recent": self.list_recent(),
            "ttl_minutes": int(self.default_ttl.total_seconds() // 60),
        }

    def prune_expired(self):
        now = datetime.utcnow()
        expired = [
            jid for jid, job in self._jobs.items()
            if job.keep_until and job.keep_until < now
        ]
        for jid in expired:
            self._jobs.pop(jid, None)
        return expired


jobs = JobStore(default_ttl_minutes=config.job_ttl_minutes,
                max_jobs=config.max_jobs)
