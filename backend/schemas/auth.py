from pydantic import BaseModel
from typing import Optional


class RegisterRequest(BaseModel):
    username: str
    password: str
    email: Optional[str] = None


class LoginRequest(BaseModel):
    username: str
    password: str


class UserProfileResponse(BaseModel):
    user_id: int
    username: str
    email: Optional[str] = None
    avatar_url: Optional[str] = None
    has_profile: bool = False
