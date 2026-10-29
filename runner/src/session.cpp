#include "session.hpp"

#include "log.hpp"

namespace dbui {

Session::Session(std::string name, OnSkipped onSkipped) : name_(std::move(name)), onSkipped_(std::move(onSkipped)) {}

Session::~Session() {
  stop();
  std::lock_guard lock(driverMu_);
  driver_.reset();
}

void Session::start() { thread_ = std::thread([this] { loop(); }); }

void Session::stop() {
  bool running = false;
  {
    std::lock_guard lock(mu_);
    if (stopping_ && !thread_.joinable()) return;
    stopping_ = true;
    queue_.clear();
    if (runningToken_) {
      runningToken_->cancelled = true;
      running = true;
    }
  }
  if (running) {
    std::lock_guard lock(driverMu_);
    if (driver_) driver_->cancel();
  }
  cv_.notify_all();
  if (thread_.joinable()) thread_.join();
}

void Session::submit(long long id, Work work) {
  {
    std::lock_guard lock(mu_);
    if (stopping_) return;
    queue_.push_back(Job{id, std::move(work), std::make_shared<CancelToken>()});
  }
  cv_.notify_one();
}

bool Session::cancel(long long target) {
  bool skipped = false;
  bool running = false;
  {
    std::lock_guard lock(mu_);
    for (auto it = queue_.begin(); it != queue_.end(); ++it) {
      if (it->id == target) {
        queue_.erase(it);
        skipped = true;
        break;
      }
    }
    if (!skipped && runningId_ == target && runningToken_) {
      runningToken_->cancelled = true;
      running = true;
    }
  }
  if (skipped) {
    log::info(name_ + ": dropped queued job " + std::to_string(target));
    if (onSkipped_) onSkipped_(target);
    return true;
  }
  if (running) {
    log::info(name_ + ": cancelling running job " + std::to_string(target));
    std::lock_guard lock(driverMu_);
    if (driver_) driver_->cancel();
    return true;
  }
  return false;
}

void Session::setDriver(std::unique_ptr<Driver> d) {
  std::unique_ptr<Driver> old;
  {
    std::lock_guard lock(driverMu_);
    old = std::move(driver_);
    driver_ = std::move(d);
  }
  // `old` is destroyed here, outside the lock, so closing a connection never blocks cancel().
}

void Session::loop() {
  for (;;) {
    Job job;
    {
      std::unique_lock lock(mu_);
      cv_.wait(lock, [this] { return stopping_ || !queue_.empty(); });
      if (stopping_) break;
      job = std::move(queue_.front());
      queue_.pop_front();
      runningId_ = job.id;
      runningToken_ = job.token;
    }
    job.work(*job.token);
    {
      std::lock_guard lock(mu_);
      runningId_ = -1;
      runningToken_.reset();
    }
  }
  setDriver(nullptr);
}

}  // namespace dbui
